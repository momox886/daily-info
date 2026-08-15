import 'dotenv/config';
import cron from 'node-cron';

import { logger } from './logger.js';
import { fetchAllNews } from './fetchNews.js';
import {
  filterByDate,
  filterByKeywords,
  filterDuplicates,
  rollbackDuplicates,
} from './filterNews.js';
import { sendNews, sendTopContent, buildTopContent, buildEmbed } from './sendDiscord.js';
import { summarizeArticles } from './summarize.js';

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

  // 1. Récupération RSS (les sources en échec renvoient déjà [] et logguent)
  const allArticles = await fetchAllNews();
  logger.info(`Récupéré ${allArticles.length} articles bruts au total`);

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

  // 7. Mode dry-run : on affiche ce qui aurait été envoyé sans rien envoyer.
  if (dryRun) {
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
    if (topArticles.length > 0) {
      await sendTopContent(topArticles, env.DISCORD_WEBHOOK_URL, options);
      console.log(`[send] Message "À la une" envoyé (${topArticles.length} articles)`);
    }
    const messages = await sendNews(rest.length > 0 ? rest : [], env);
    const sent = topArticles.length + rest.length;
    logger.info(`Envoyé ${sent} articles (${topArticles.length} à la une + ${rest.length} en embeds) dans ${messages + (topArticles.length > 0 ? 1 : 0)} message(s) Discord.`);
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
