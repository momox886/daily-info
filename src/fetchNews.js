import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Parser from 'rss-parser';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Petit parser par défaut : on ajoute "content:encoded", les images media:*
// et un timeout pour qu'une source morte ne bloque jamais le cycle.
const parser = new Parser({
  timeout: 20000,
  customFields: {
    item: [
      ['content:encoded', 'contentEncoded'],
      ['media:content', 'mediaContent', { keepArray: true }],
      ['media:thumbnail', 'mediaThumbnail', { keepArray: true }],
    ],
  },
});

// Noms de jours/mois français (RFC 822 à la française, ex: ZDNet) vers anglais,
// pour que Date.parse() puisse les interpréter.
const FR_DAYS = { dim: 'Sun', lun: 'Mon', mar: 'Tue', mer: 'Wed', jeu: 'Thu', ven: 'Fri', sam: 'Sat' };
const FR_MONTHS = {
  'janv.': 'Jan', janvier: 'Jan',
  'févr.': 'Feb', 'févr': 'Feb', février: 'Feb',
  mars: 'Mar', 'avr.': 'Apr', avril: 'Apr', mai: 'May', juin: 'Jun',
  'juil.': 'Jul', juillet: 'Jul', 'août': 'Aug', aout: 'Aug',
  'sept.': 'Sep', septembre: 'Sep', oct: 'Oct', 'oct.': 'Oct', octobre: 'Oct',
  'nov.': 'Nov', novembre: 'Nov', 'déc.': 'Dec', 'déc': 'Dec', décembre: 'Dec',
};

/**
 * Normalise une date de flux en ISO 8601 (ou null si illisible).
 * Gère les dates RFC 822 avec noms de jours/mois en français.
 * @param {string|null|undefined} value
 * @returns {string|null}
 */
export function parsePubDate(value) {
  if (!value) return null;
  let str = String(value).replace(/^[a-zéû]+,?\s*/i, ''); // retire le jour de la semaine
  for (const [fr, en] of Object.entries(FR_MONTHS)) {
    str = str.replace(new RegExp(fr, 'gi'), en);
  }
  for (const [fr, en] of Object.entries(FR_DAYS)) {
    str = str.replace(new RegExp(fr, 'gi'), en);
  }
  const ts = Date.parse(str);
  return Number.isNaN(ts) ? null : new Date(ts).toISOString();
}

/**
 * Nettoie un texte issu du flux : retire les balises HTML, les espaces multiples
 * et limite la longueur.
 * @param {string} html
 * @param {number} maxLength
 * @returns {string}
 */
export function cleanHtml(html, maxLength = 300) {
  if (!html) return '';
  return html
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maxLength);
}

/**
 * Extrait une image d'article depuis le flux (media:content, enclosure,
 * media:thumbnail ou première <img> du contenu). Retourne null si aucune.
 * @param {object} item
 * @returns {string|null}
 */
export function extractImage(item) {
  if (!item) return null;
  const enclosure = item.enclosure;
  if (enclosure?.url && /^image\//.test(enclosure.type || '')) return enclosure.url;
  if (Array.isArray(item.mediaContent)) {
    const mc = item.mediaContent.find((m) => m?.url);
    if (mc?.url) return mc.url;
  }
  if (Array.isArray(item.mediaThumbnail)) {
    const mt = item.mediaThumbnail.find((m) => m?.url);
    if (mt?.url) return mt.url;
  }
  const content = item.contentEncoded || item.content || '';
  const match = content.match(/<img[^>]+src=["']([^"']+)["']/i);
  return match ? match[1] : null;
}

/**
 * Vérifie qu'une URL pointe bien vers une image (Content-Type image/*) et
 * renvoie l'URL finale après redirections. Retourne null si ce n'est pas une
 * image ou si le serveur ne répond pas. Utile pour les URLs sans extension
 * (ex : image.theregister.com/?imageId=...) que Discord n'accepterait pas.
 * @param {string} url
 * @param {number} timeoutMs
 * @returns {Promise<string|null>}
 */
export async function verifyImageUrl(url, timeoutMs = 6000) {
  if (!url) return null;
  const doFetch = (method) =>
    fetch(url, { method, redirect: 'follow', signal: AbortSignal.timeout(timeoutMs) });

  let res;
  try {
    res = await doFetch('HEAD');
  } catch {
    res = null;
  }
  // Certains serveurs (et CDN) refusent HEAD (405) : on retente en GET et on
  // libère le corps immédiatement, on ne veut que les en-têtes.
  if (!res || res.status === 405 || !res.ok) {
    try {
      res = await doFetch('GET');
      if (res?.body) res.body.cancel().catch(() => {});
    } catch {
      return null;
    }
  }
  if (!res || !res.ok) return null;

  const type = (res.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
  if (!type.startsWith('image/')) return null;
  return res.url || url;
}

/**
 * Charge la liste des sources RSS depuis config/sources.json.
 * @returns {Array<{name: string, url: string, category: string}>}
 */
export function loadSources() {
  const filePath = path.join(__dirname, '..', 'config', 'sources.json');
  const raw = fs.readFileSync(filePath, 'utf-8');
  const data = JSON.parse(raw);
  return data.sources || [];
}

/**
 * Récupère les articles d'une source RSS.
 * En cas d'échec (et si un fallbackUrl est défini dans sources.json), on tente
 * l'URL de secours. Renvoie toujours {ok, articles, error} : l'appelant décide
 * (une source en échec ne bloque pas les autres).
 * @param {{name: string, url: string, fallbackUrl?: string, category: string}} source
 * @returns {Promise<{ok: boolean, articles: Array<object>, error?: string}>}
 */
export async function fetchSource(source) {
  try {
    const feed = await parser.parseURL(source.url);
    return { ok: true, articles: mapFeedItems(source, feed) };
  } catch (err) {
    if (source.fallbackUrl) {
      try {
        const feed = await parser.parseURL(source.fallbackUrl);
        return { ok: true, articles: mapFeedItems(source, feed) };
      } catch (fallbackErr) {
        console.error(`[fetch] Échec du fallback "${source.name}" (${source.fallbackUrl}) : ${fallbackErr.message}`);
        return { ok: false, articles: [], error: fallbackErr.message };
      }
    }
    console.error(`[fetch] Échec de la source "${source.name}" (${source.url}) : ${err.message}`);
    return { ok: false, articles: [], error: err.message };
  }
}

/**
 * Convertit les items d'un flux en articles normalisés.
 * @param {{name: string, category: string}} source
 * @param {object} feed
 * @returns {Array<object>}
 */
function mapFeedItems(source, feed) {
  return (feed.items || []).map((item) => {
    // Les flux CERT-FR n'ont pas toujours de guid : on retombe sur le lien.
    const link = item.link || item.guid || '';
    return {
      title: (item.title || '').trim(),
      link,
      guid: item.guid || link,
      pubDate: parsePubDate(item.isoDate || item.pubDate),
      description: cleanHtml(
        item.contentSnippet || item.contentEncoded || item.summary || item.description || '',
      ),
      image: extractImage(item),
      source: source.name,
      category: source.category,
    };
  });
}

/**
 * Récupère les articles de toutes les sources en parallèle.
 * @returns {Promise<{articles: Array<object>, statuses: Array<{name: string, ok: boolean, error?: string}>}>}
 */
export async function fetchAllNews() {
  const sources = loadSources();
  const results = await Promise.all(sources.map((s) => fetchSource(s)));
  return {
    articles: results.flatMap((r) => r.articles),
    statuses: sources.map((s, i) => ({ name: s.name, ok: results[i].ok, error: results[i].error })),
  };
}
