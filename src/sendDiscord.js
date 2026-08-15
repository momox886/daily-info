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
 * Construit l'objet embed Discord d'un article.
 * @param {object} article
 * @param {object} config
 * @returns {object}
 */
export function buildEmbed(article, config = {}) {
  const text = `${article.title} ${article.description} ${article.summary || ''}`;
  const title = article.highlight ? `⭐ ${article.title}` : article.title;

  // Description = résumé LLM (s'il existe) puis description brute du flux.
  const parts = [];
  if (article.summary) parts.push(`**Résumé :** ${article.summary}`);
  if (article.description) parts.push(article.description);
  const description = parts.join('\n\n').slice(0, 2048);

  const embed = {
    title: title.slice(0, 256),
    url: article.link,
    description: description || undefined,
    color: pickColor(text, config.keywords),
    footer: {
      text: `${article.source}${article.pubDate ? ` · ${formatDate(article.pubDate)}` : ''}`,
    },
  };

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
 */
export async function sendNews(articles, env = process.env) {
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

  for (const batch of batches) {
    await sendBatch(batch, env.DISCORD_WEBHOOK_URL, options);
    console.log(`[send] Message envoyé (${batch.length} articles)`);
  }
  return batches.length;
}
