import 'dotenv/config';
import cron from 'node-cron';

import { logger } from './logger.js';
import { fetchAllNews, verifyImageUrl } from './fetchNews.js';
import {
  filterByDate,
  filterByKeywords,
  filterDuplicates,
  rollbackDuplicates,
} from './filterNews.js';
import { sendNews, sendTopContent, sendAlert, sendBanner, buildTopContent, buildEmbed } from './sendDiscord.js';
import { summarizeArticles } from './summarize.js';
import { recordSourceHealth } from './sourceHealth.js';

const DEFAULT_TIMEZONE = 'Europe/Paris';
const args = process.argv.slice(2);

/**
 * Exécute un cycle complet : récupération → filtrage → anti-doublon → envoi.
 * @param {object} env
 * @param {boolean} dryRun n'affiche rien sur Discord
 * @returns {Promise<{total: number, sent: number, errors: number}>}
 */
export async function runOnce(env = process.env, dryRun = false) {
  logger.info('Démarrage du cycle de récupération des actualités...');

  // 1. Récupération RSS (les sources en échec renvoient [] sans bloquer les autres)
  const { articles: allArticles, statuses } = await fetchAllNews();
  logger.info(`Récupéré ${allArticles.length} articles bruts au total (${statuses.filter((s) => !s.ok).length} source(s) en échec)`);

  // 2. Santé des sources : détecte les sources en panne répétée et les retours.
  const alertsEnabled = String(env.ENABLE_SOURCE_ALERTS ?? 'true').toLowerCase() === 'true';
  const healthThreshold = Number(env.SOURCE_ALERT_THRESHOLD) || 3;
  const { alerts, recoveries } = recordSourceHealth(statuses, healthThreshold);
  if (alerts.length > 0) {
    logger.warn(`Sources en panne depuis ${healthThreshold}+ jours : ${alerts.map((a) => a.name).join(', ')}`);
  }
  if (recoveries.length > 0) {
    logger.info(`Sources de retour à la normale : ${recoveries.join(', ')}`);
  }

  // 2. Filtre par date (dernières LOOKBACK_HOURS heures)
  const lookback = Number(env.LOOKBACK_HOURS) || 24;
  const recent = filterByDate(allArticles, lookback);
  logger.info(`${recent.length} articles publiés depuis ${lookback} heure(s)`);

  // 3. Filtre par mots-clés (include / exclude optionnels)
  const parseList = (s) => (s ? s.split(',').map((k) => k.trim()).filter(Boolean) : []);
  const byKeywords = filterByKeywords(recent, {
    include: parseList(env.INCLUDE_KEYWORDS),
    exclude: parseList(env.EXCLUDE_KEYWORDS),
  });
  logger.info(`${byKeywords.length} articles après filtrage par mots-clés`);

  // 4. Anti-doublon (les nouveaux liens sont marqués comme envoyés)
  const fresh = filterDuplicates(byKeywords);
  logger.info(`${fresh.length} nouveaux articles à envoyer (${byKeywords.length - fresh.length} déjà vus)`);

  if (fresh.length === 0) {
    logger.info('Aucun nouvel article : rien à envoyer.');
    return { total: allArticles.length, sent: 0, errors: 0 };
  }

  // 5. Résumé LLM (optionnel) : résume, note la pertinence, ajoute les détails
  //    techniques, dédoublonne les sujets et réordonne. Un échec du LLM
  //    n'arrête jamais l'envoi : on repart sur les articles bruts.
  let ready = fresh;
  let droppedByDedup = [];
  if (String(env.ENABLE_SUMMARIZATION ?? 'true').toLowerCase() === 'true' && (env.GROQ_API_KEY || env.LLM_API_KEY)) {
    try {
      const result = await summarizeArticles(fresh, env);
      ready = result.articles;
      droppedByDedup = result.dropped;
      const summarized = ready.filter((a) => a.summary).length;
      const highlights = ready.filter((a) => a.highlight).length;
      logger.info(
        `Résumé LLM : ${summarized} articles résumés, ${highlights} marqués à lire en entier, ` +
        `${droppedByDedup.length} doublons de sujet fusionnés.`,
      );
    } catch (err) {
      logger.warn(`Résumé LLM désactivé (${err.message}) — envoi sans résumés.`);
    }
  } else {
    logger.info('Résumé LLM désactivé (ENABLE_SUMMARIZATION=false ou clé Groq absente).');
  }

  // 6. Message "À la une du jour" : les N premiers articles (tri par
  //    pertinence du LLM), puis le reste en embeds. Sans classement LLM,
  //    tout part en embeds (un "top" sans pertinence n'aurait pas de sens).
  const hasRanking = ready.some((a) => typeof a.relevance === 'number');
  const topEnabled = String(env.ENABLE_TOP3 ?? 'true').toLowerCase() === 'true' && hasRanking;
  const topN = Math.max(0, Number(env.TOP_N) || 3);
  const topArticles = topEnabled && ready.length > 0 ? ready.slice(0, Math.min(topN, ready.length)) : [];
  const rest = topArticles.length > 0 ? ready.slice(topArticles.length) : ready;
  logger.info(`Répartition : ${topArticles.length} à la une (dont ${topArticles.filter((a) => a.image).length} avec image) + ${rest.length} en embeds (dont ${rest.filter((a) => a.image).length} avec image)`);

  // 6bis. Vérification des images : les URLs extraites des flux (souvent sans
  // extension) sont contrôlées (Content-Type image/*) avant l'envoi. Seules
  // les URLs valides deviennent des thumbnails.
  const imageUrls = [...new Set(ready.map((a) => a.image).filter(Boolean))];
  const verified = new Map();
  await Promise.allSettled(
    imageUrls.map(async (url) => {
      const finalUrl = await verifyImageUrl(url);
      if (finalUrl) verified.set(url, finalUrl);
    }),
  );
  for (const article of ready) {
    if (article.image) article.image = verified.get(article.image) || null;
  }
  if (imageUrls.length > 0) {
    logger.info(`Images : ${[...verified.keys()].length}/${imageUrls.length} URLs validées (${imageUrls.length - verified.size} non-images ignorées)`);
  }

  // 7. Mode dry-run : on affiche ce qui aurait été envoyé sans rien envoyer.
  if (dryRun) {
    if (alertsEnabled && (alerts.length > 0 || recoveries.length > 0)) {
      console.log('\n=== Alertes sources ===');
      for (const a of alerts) {
        console.log(`  ⚠️  ${a.name} : ${a.failures} échecs consécutifs (dernier succès : ${a.lastOk ? new Date(a.lastOk).toLocaleDateString('fr-FR') : 'inconnu'})`);
      }
      for (const name of recoveries) {
        console.log(`  ✅ ${name} : de retour à la normale`);
      }
    }
    logger.info(`[DRY-RUN] ${ready.length} articles auraient été envoyés :`);
    if (topArticles.length > 0) {
      console.log(`\n=== Message "À la une" (${topArticles.length}) ===`);
      console.log(buildTopContent(topArticles));
    }
    if (rest.length > 0) {
      console.log(`\n=== Embeds (${rest.length}) ===`);
    }
    for (const article of rest) {
      const embed = buildEmbed(article);
      console.log(`  - ${embed.title} (${article.source})`);
      console.log(`    ${article.link}`);
      console.log(`    couleur=#${embed.color.toString(16)} pertinence=${article.relevance ?? '-'} à-lire=${article.highlight ? 'oui' : 'non'} gravité=${article.severity ?? '-'}`);
      if (article.summary) console.log(`    résumé: ${article.summary}`);
      if (article.technicalDetails) console.log(`    détails: ${article.technicalDetails}`);
    }
    if (droppedByDedup.length > 0) {
      console.log(`\n=== ${droppedByDedup.length} doublons de sujet fusionnés (non envoyés) ===`);
      for (const article of droppedByDedup) {
        console.log(`  - ${article.title} (${article.source})`);
      }
    }
    // Ne pas marquer les articles comme envoyés puisqu'on n'a rien envoyé.
    rollbackDuplicates(fresh);
    return { total: allArticles.length, sent: 0, errors: 0 };
  }

  // 8. Envoi réel sur Discord
  if (!env.DISCORD_WEBHOOK_URL) {
    logger.error('DISCORD_WEBHOOK_URL est manquant dans .env — arrêt avant envoi.');
    return { total: allArticles.length, sent: 0, errors: 1 };
  }

  try {
    const options = {
      botUsername: env.BOT_USERNAME || 'Cyber News Bot',
      botIconUrl: env.BOT_ICON_URL || undefined,
    };

    // Bandeau d'en-tête : marqueur de séparation (démarque le lot du jour des
    // articles déjà postés) + résumé (date, compte, santé des sources).
    const dayBanner = String(env.ENABLE_DAY_BANNER ?? 'true').toLowerCase() === 'true';
    const sourcesDown = statuses.filter((s) => !s.ok).length;
    if (dayBanner) {
      await sendBanner({
        total: allArticles.length,
        sent: topArticles.length + rest.length,
        topCount: topArticles.length,
        restCount: rest.length,
        sourcesDown,
        sourcesTotal: statuses.length,
        alerts,
        recoveries,
      }, env.DISCORD_WEBHOOK_URL, options);
      console.log('[send] Bandeau du jour envoyé');
    }

    // Alertes de santé des sources : détail (date du dernier succès, retour).
    if (alertsEnabled && (alerts.length > 0 || recoveries.length > 0)) {
      const parts = [];
      for (const a of alerts) {
        parts.push(`⚠️ **${a.name}** : en panne depuis ${a.failures} exécutions consécutives${a.lastOk ? ` (dernier succès : ${new Date(a.lastOk).toLocaleDateString('fr-FR')})` : ''}.`);
      }
      for (const name of recoveries) {
        parts.push(`✅ **${name}** : la source est de retour à la normale.`);
      }
      await sendAlert(parts.join('\n'), env.DISCORD_WEBHOOK_URL, options);
      console.log('[send] Alerte santé des sources envoyée');
    }

    if (topArticles.length > 0) {
      await sendTopContent(topArticles, env.DISCORD_WEBHOOK_URL, options);
      console.log(`[send] Message "À la une" envoyé (${topArticles.length} articles)`);
    }

    // Séparateur avant les embeds du reste, puis envoi par lots.
    const divider = dayBanner && rest.length > 0 ? '── 📚 **Autres articles** ──' : undefined;
    const messages = await sendNews(rest.length > 0 ? rest : [], env, divider);
    const sent = topArticles.length + rest.length;
    logger.info(`Envoyé ${sent} articles (${topArticles.length} à la une + ${rest.length} en embeds) dans ${messages + 1 + (topArticles.length > 0 ? 1 : 0)} message(s) Discord.`);
    return { total: allArticles.length, sent, errors: 0 };
  } catch (err) {
    logger.error(`Échec de l'envoi Discord : ${err.message}`);
    return { total: allArticles.length, sent: 0, errors: 1 };
  }
}

/**
 * Mode "daemon" (npm start) : lance un cycle immédiat puis planifie
 * un cycle quotidien avec node-cron.
 */
async function daemonMode() {
  const schedule = process.env.SCHEDULE_CRON || '0 8 * * *';
  const timezone = process.env.TZ || DEFAULT_TIMEZONE;

  logger.info(`Mode démon : exécution immédiate puis planification "${schedule}" (${timezone})`);
  await runOnce();

  if (!cron.validate(schedule)) {
    logger.error(`SCHEDULE_CRON invalide : "${schedule}" — le processus s'arrête.`);
    process.exit(1);
  }

  cron.schedule(schedule, () => runOnce(), { timezone });
  logger.info(`Planifié : ${schedule} (${timezone}) — Ctrl+C pour arrêter.`);
}

/**
 * Mode one-shot (npm run daily / GitHub Actions / cron système) :
 * un seul cycle puis sortie, avec code de sortie non nul en cas d'erreur fatale.
 */
async function oneShotMode() {
  const result = await runOnce(process.env, args.includes('--dry-run'));
  logger.info(`Résumé : ${result.total} trouvés, ${result.sent} envoyés, ${result.errors} erreurs.`);
  process.exit(result.errors > 0 ? 1 : 0);
}

if (args.includes('--help') || args.includes('-h')) {
  console.log(`
Usage : node src/index.js [options]

Options :
  --dry-run   Affiche les articles qui seraient envoyés sans contacter Discord
  --once      Exécute un seul cycle puis quitte (npm run daily)
  --help      Affiche cette aide

Modes :
  npm start         Démon : cycle immédiat + planification quotidienne (node-cron)
  npm run daily     One-shot : un cycle puis sortie (cron système / GitHub Actions)
`);
  process.exit(0);
}

// --once est implicite quand on lance via npm run daily, mais on permet aussi
// l'usage explicite. Sinon, mode démon.
if (args.includes('--once')) {
  oneShotMode();
} else {
  daemonMode();
}
