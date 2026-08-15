import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Parser from 'rss-parser';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Petit parser par défaut : on ajoute "content:encoded" pour garder une
// description plus riche quand le flux la fournit.
const parser = new Parser({
  customFields: {
    item: [['content:encoded', 'contentEncoded']],
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
 * Récupère les articles d'une source RSS.
 * En cas d'échec (et si un fallbackUrl est défini dans sources.json), on tente
 * l'URL de secours. Si tout échoue, renvoie un tableau vide (ne bloque pas le reste).
 * @param {{name: string, url: string, fallbackUrl?: string, category: string}} source
 * @returns {Promise<Array<object>>}
 */
export async function fetchSource(source) {
  try {
    const feed = await parser.parseURL(source.url);
    return mapFeedItems(source, feed);
  } catch (err) {
    if (source.fallbackUrl) {
      console.warn(
        `[fetch] Échec de "${source.name}" (${source.url}) : ${err.message} — tentative sur l'URL de secours...`,
      );
      try {
        const feed = await parser.parseURL(source.fallbackUrl);
        return mapFeedItems(source, feed);
      } catch (fallbackErr) {
        console.error(`[fetch] Échec du fallback "${source.name}" (${source.fallbackUrl}) : ${fallbackErr.message}`);
        return [];
      }
    }
    console.error(`[fetch] Échec de la source "${source.name}" (${source.url}) : ${err.message}`);
    return [];
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
      source: source.name,
      category: source.category,
    };
  });
}
/**
 * Récupère les articles de toutes les sources en parallèle.
 * @returns {Promise<Array<object>>}
 */
export async function fetchAllNews() {
  const sources = loadSources();
  const results = await Promise.all(sources.map((s) => fetchSource(s)));
  return results.flat();
}
