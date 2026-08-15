import 'dotenv/config';

const DISCORD_MAX_EMBEDS = 10; // limite Discord : 10 embeds par message

// Couleurs des embeds (entiers Discord)
const COLOR_GREEN = 0x2ecc71; // normal
const COLOR_ORANGE = 0xe67e22; // prioritaire
const COLOR_RED = 0xe74c3c; // critique

// Mots-clés par défaut : préfixe "!" dans PRIORITY_KEYWORDS = critique (rouge),
// sinon prioritaire (orange).
const DEFAULT_CRITICAL_KEYWORDS = ['CVE', 'zero-day', 'exploit', 'vulnérabilité critique', 'zero day'];
const DEFAULT_HIGH_KEYWORDS = ['ransomware', 'faille'];

/**
 * Interprète PRIORITY_KEYWORDS (env) en deux listes : critique / prioritaire.
 * Si non défini, renvoie les mots-clés par défaut.
 * @param {string|undefined} raw
 * @returns {{critical: string[], high: string[]}}
 */
function parseKeywords(raw) {
  const list = raw && raw.trim()
    ? raw.split(',').map((k) => k.trim()).filter(Boolean)
    : [];
  if (list.length === 0) {
    return { critical: DEFAULT_CRITICAL_KEYWORDS, high: DEFAULT_HIGH_KEYWORDS };
  }
  const critical = [];
  const high = [];
  for (const k of list) {
    if (k.startsWith('!')) critical.push(k.slice(1).toLowerCase());
    else high.push(k.toLowerCase());
  }
  if (critical.length === 0 && high.length === 0) {
    return { critical: DEFAULT_CRITICAL_KEYWORDS, high: DEFAULT_HIGH_KEYWORDS };
  }
  return { critical, high };
}

/**
 * Détermine la couleur d'un embed selon les mots-clés trouvés dans le contenu.
 * @param {string} text
 * @param {{critical?: string[], high?: string[]}} keywords
 * @returns {number}
 */
export function pickColor(text, keywords = {}) {
  const lower = text.toLowerCase();
  const critical = keywords.critical || DEFAULT_CRITICAL_KEYWORDS;
  const high = keywords.high || DEFAULT_HIGH_KEYWORDS;
  if (critical.some((k) => lower.includes(k.toLowerCase()))) return COLOR_RED;
  if (high.some((k) => lower.includes(k.toLowerCase()))) return COLOR_ORANGE;
  return COLOR_GREEN;
}

/**
 * Formate une date ISO en français (ex: 15/08/2026 09:30).
 * @param {string} dateStr
 * @returns {string}
 */
function formatDate(dateStr) {
  if (!dateStr) return '';
  const d = new Date(dateStr);
  if (Number.isNaN(d.getTime())) return '';
  const pad = (n) => String(n).padStart(2, '0');
  return `${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${d.getFullYear()} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/**
 * Couleur d'un embed selon la gravité annoncée par le LLM (si présente),
 * sinon par mots-clés.
 * @param {object} article
 * @param {{critical?: string[], high?: string[]}} keywords
 * @returns {number}
 */
function pickSeverityColor(article, keywords) {
  if (article.severity === 'critical') return COLOR_RED;
  if (article.severity === 'high') return COLOR_ORANGE;
  if (article.severity === 'medium' || article.severity === 'low') return COLOR_GREEN;
  const text = `${article.title} ${article.description} ${article.summary || ''}`;
  return pickColor(text, keywords);
}

/**
 * Emoji affiché selon la gravité LLM (repérage visuel rapide dans Discord).
 * @param {string|null|undefined} severity
 * @returns {string}
 */
export function severityEmoji(severity) {
  switch (severity) {
    case 'critical': return '🔴';
    case 'high': return '🟠';
    case 'medium': return '🟡';
    case 'low': return '🟢';
    default: return '';
  }
}

/**
 * Construit l'objet embed Discord d'un article.
 * @param {object} article
 * @param {object} config
 * @returns {object}
 */
export function buildEmbed(article, config = {}) {
  const title = `${severityEmoji(article.severity)} ${article.highlight ? '⭐ ' : ''}${article.title}`.trim();

  // Description = résumé LLM, détails techniques (LLM) puis description du flux.
  const parts = [];
  if (article.summary) parts.push(`**Résumé :** ${article.summary}`);
  if (article.technicalDetails) parts.push(`**Détails techniques :** ${article.technicalDetails}`);
  if (article.description) parts.push(article.description);
  const description = parts.join('\n\n').slice(0, 2048);

  const embed = {
    title: title.slice(0, 256),
    url: article.link,
    description: description || undefined,
    color: pickSeverityColor(article, config.keywords),
    footer: {
      text: `${article.source}${article.pubDate ? ` · ${formatDate(article.pubDate)}` : ''}`,
    },
  };

  // Miniature : l'URL est vérifiée (Content-Type image/*) au moment de l'envoi
  // dans index.js — ici on n'accepte que du http(s) valide.
  if (/^https?:\/\/\S+$/i.test(article.image || '')) {
    embed.thumbnail = { url: article.image };
  }

  // Pertinence et badge "à lire en entier" en champs d'embed quand dispo.
  if (typeof article.relevance === 'number') {
    embed.fields = [
      { name: 'Pertinence', value: `${article.relevance}/10`, inline: true },
    ];
    if (article.highlight) {
      embed.fields.push({ name: 'À lire', value: '⭐ En entier', inline: true });
    }
  }

  // Le champ timestamp est optionnel : on ne l'ajoute que si la date est valide,
  // sinon Discord rejette le payload (erreur 400).
  const ts = article.pubDate ? Date.parse(article.pubDate) : NaN;
  if (!Number.isNaN(ts)) embed.timestamp = article.pubDate;
  return embed;
}

/**
 * Regroupe les articles en lots de `maxPerMessage` embeds (max Discord : 10).
 * @param {Array<object>} articles
 * @param {number} maxPerMessage
 * @returns {Array<Array<object>>}
 */
export function groupIntoMessages(articles, maxPerMessage = DISCORD_MAX_EMBEDS) {
  const batches = [];
  for (let i = 0; i < articles.length; i += maxPerMessage) {
    batches.push(articles.slice(i, i + maxPerMessage));
  }
  return batches;
}

/**
 * Envoie un lot d'articles dans Discord via le webhook.
 * @param {Array<object>} articles
 * @param {string} webhookUrl
 * @param {{botUsername?: string, botIconUrl?: string, keywords?: object}} options
 */
export async function sendBatch(articles, webhookUrl, options = {}) {
  const payload = {
    username: options.botUsername || 'Cyber News Bot',
    embeds: articles.map((a) => buildEmbed(a, { keywords: options.keywords })),
  };
  // Séparateur optionnel : texte affiché au-dessus du premier lot d'embeds.
  if (options.headerContent) payload.content = options.headerContent;
  if (options.botIconUrl) payload.avatar_url = options.botIconUrl;

  const res = await fetch(webhookUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });

  if (!res.ok) {
    const detail = await res.text();
    throw new Error(`Discord a répondu ${res.status} : ${detail.slice(0, 300)}`);
  }
}

/**
 * Point d'entrée d'envoi : découpe en messages et envoie tout sur Discord.
 * @param {Array<object>} articles
 * @param {object} env variables d'environnement (déjà chargées)
 * @param {string} [headerContent] texte affiché au-dessus du premier lot (séparateur)
 */
export async function sendNews(articles, env = process.env, headerContent) {
  if (!env.DISCORD_WEBHOOK_URL) {
    throw new Error('DISCORD_WEBHOOK_URL est manquant dans .env');
  }

  const maxPerMessage = Number(env.MAX_EMBEDS_PER_MESSAGE) || DISCORD_MAX_EMBEDS;
  const batches = groupIntoMessages(articles, maxPerMessage);
  const options = {
    botUsername: env.BOT_USERNAME || 'Cyber News Bot',
    botIconUrl: env.BOT_ICON_URL || undefined,
    keywords: parseKeywords(env.PRIORITY_KEYWORDS),
  };

  for (const [index, batch] of batches.entries()) {
    await sendBatch(batch, env.DISCORD_WEBHOOK_URL, {
      ...options,
      headerContent: index === 0 ? headerContent : undefined,
    });
    console.log(`[send] Message envoyé (${batch.length} articles)`);
  }
  return batches.length;
}

/**
 * Construit le contenu texte du message "Top N du jour" (markdown Discord).
 * @param {Array<object>} articles déjà triés par pertinence décroissante
 * @returns {string}
 */
export function buildTopContent(articles) {
  const lines = articles.map((a, i) => {
    const badge = a.highlight ? ' ⭐' : '';
    const summary = a.summary ? `\n_${a.summary}_` : '';
    return `${i + 1}. **${a.title}** — ${a.source}${badge}\n<${a.link}>${summary}`;
  });
  return `🔥 **À la une aujourd'hui** 🔥\n\n${lines.join('\n\n')}`;
}

/**
 * Envoie le message "Top N du jour" via le webhook. Les articles du top qui
 * ont une image sont aussi envoyés en embeds (thumbnail) dans le même message :
 * le texte résume le top, les embeds apportent l'illustration.
 * @param {Array<object>} articles
 * @param {string} webhookUrl
 * @param {{botUsername?: string, botIconUrl?: string, keywords?: object}} options
 */
export async function sendTopContent(articles, webhookUrl, options = {}) {
  const payload = {
    username: options.botUsername || 'Cyber News Bot',
    content: buildTopContent(articles),
    embeds: articles
      .filter((a) => /^https?:\/\/\S+$/i.test(a.image || ''))
      .map((a) => buildEmbed(a, { keywords: options.keywords })),
  };
  if (payload.embeds.length === 0) delete payload.embeds;
  if (options.botIconUrl) payload.avatar_url = options.botIconUrl;

  const res = await fetch(webhookUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });

  if (!res.ok) {
    const detail = await res.text();
    throw new Error(`Discord a répondu ${res.status} : ${detail.slice(0, 300)}`);
  }
}

/**
 * Envoie un message texte simple (alerte source en panne, etc.).
 * @param {string} content
 * @param {string} webhookUrl
 * @param {{botUsername?: string, botIconUrl?: string}} options
 */
export async function sendAlert(content, webhookUrl, options = {}) {
  const payload = {
    username: options.botUsername || 'Cyber News Bot',
    content,
  };
  if (options.botIconUrl) payload.avatar_url = options.botIconUrl;

  const res = await fetch(webhookUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });

  if (!res.ok) {
    const detail = await res.text();
    throw new Error(`Discord a répondu ${res.status} : ${detail.slice(0, 300)}`);
  }
}

/**
 * Envoie le message de tête du digest : un marqueur de séparation (pour
 * démarquer visuellement le nouveau lot des articles déjà postés) suivi d'un
 * bandeau récapitulatif (date, nombre d'articles, état des sources).
 * @param {{total: number, sent: number, topCount: number, restCount: number,
 *          sourcesDown: number, sourcesTotal: number,
 *          alerts: Array<{name: string}>, recoveries: Array<string>}} stats
 * @param {string} webhookUrl
 * @param {{botUsername?: string, botIconUrl?: string}} options
 */
export async function sendBanner(stats, webhookUrl, options = {}) {
  const day = new Date().toLocaleDateString('fr-FR', {
    weekday: 'long', day: 'numeric', month: 'long', year: 'numeric',
  });
  const separator = `════ 🆕 **Articles du jour — ${stats.sent} nouveau(x)** ════`;

  const lines = [`📅 **${day.charAt(0).toUpperCase()}${day.slice(1)}**`];
  lines.push(`- **${stats.sent}** articles envoyés (${stats.topCount} à la une, ${stats.restCount} en embeds)`);
  lines.push(`- ${stats.total} lus au total`);
  if (stats.sourcesTotal > 0) {
    const ok = stats.sourcesTotal - stats.sourcesDown;
    const health = stats.sourcesDown === 0
      ? `✅ ${ok}/${stats.sourcesTotal} sources opérationnelles`
      : `⚠️ ${ok}/${stats.sourcesTotal} sources opérationnelles (${stats.sourcesDown} en panne : ${stats.alerts.map((a) => a.name).join(', ') || '?'})`;
    lines.push(`- ${health}`);
  }
  if (stats.recoveries.length > 0) {
    lines.push(`- ✅ De retour : ${stats.recoveries.join(', ')}`);
  }

  const payload = {
    username: options.botUsername || 'Cyber News Bot',
    content: separator,
    embeds: [
      {
        title: '📰 Résumé du jour',
        description: lines.join('\n'),
        color: stats.sourcesDown > 0 ? COLOR_ORANGE : COLOR_GREEN,
        timestamp: new Date().toISOString(),
      },
    ],
  };
  if (options.botIconUrl) payload.avatar_url = options.botIconUrl;

  const res = await fetch(webhookUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });

  if (!res.ok) {
    const detail = await res.text();
    throw new Error(`Discord a répondu ${res.status} : ${detail.slice(0, 300)}`);
  }
}
