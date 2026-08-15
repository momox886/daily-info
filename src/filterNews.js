import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const STATE_FILE = path.join(__dirname, '..', 'sent-articles.json');

/**
 * Lit l'historique des liens déjà envoyés.
 * @returns {Array<string>}
 */
function readState() {
  try {
    if (fs.existsSync(STATE_FILE)) {
      const data = JSON.parse(fs.readFileSync(STATE_FILE, 'utf-8'));
      return Array.isArray(data.sent) ? data.sent : [];
    }
  } catch (err) {
    console.error(`[state] Impossible de lire ${STATE_FILE} : ${err.message}`);
  }
  return [];
}

/**
 * Écrit l'historique des liens déjà envoyés.
 * @param {Array<string>} links
 */
function writeState(links) {
  try {
    fs.writeFileSync(STATE_FILE, JSON.stringify({ sent: links }, null, 2));
  } catch (err) {
    console.error(`[state] Impossible d'écrire ${STATE_FILE} : ${err.message}`);
  }
}

/**
 * Ne garde que les articles publiés depuis la dernière exécution.
 * Par défaut : les articles datant de moins de `lookbackHours` heures.
 * Les articles sans date sont considérés comme récents (mieux vaut un doublon
 * potentiel qu'une news manquée ; le lien sera de toute façon dédoublonné).
 * @param {Array<object>} articles
 * @param {number} lookbackHours
 * @returns {Array<object>}
 */
export function filterByDate(articles, lookbackHours = 24) {
  const now = Date.now();
  const windowMs = lookbackHours * 60 * 60 * 1000;
  return articles.filter((a) => {
    if (!a.pubDate) return true;
    const ts = Date.parse(a.pubDate);
    if (Number.isNaN(ts)) return true;
    return now - ts <= windowMs;
  });
}

/**
 * Filtre les articles selon les mots-clés à inclure / exclure.
 * L'inclusion s'applique au titre OU à la description.
 * @param {Array<object>} articles
 * @param {{include: string[], exclude: string[]}} opts
 * @returns {Array<object>}
 */
export function filterByKeywords(articles, { include = [], exclude = [] } = {}) {
  return articles.filter((a) => {
    const text = `${a.title} ${a.description}`.toLowerCase();
    if (include.length > 0 && !include.some((k) => text.includes(k.toLowerCase()))) {
      return false;
    }
    if (exclude.some((k) => text.includes(k.toLowerCase()))) {
      return false;
    }
    return true;
  });
}

/**
 * Supprime les doublons (liens déjà envoyés) et marque les nouveaux comme envoyés.
 * Un lien peut apparaître dans plusieurs flux : on garde la première occurrence.
 * @param {Array<object>} articles
 * @returns {Array<object>}
 */
export function filterDuplicates(articles) {
  const alreadySent = new Set(readState());
  const seen = new Set();
  const fresh = [];

  for (const article of articles) {
    if (!article.link) continue;
    if (alreadySent.has(article.link) || seen.has(article.link)) continue;
    seen.add(article.link);
    fresh.push(article);
  }

  // Sauvegarde immédiate : si l'envoi Discord échoue plus tard, les articles ne
  // seront pas "re-publiés" au prochain run (anti-doublon effectif dès maintenant).
  writeState([...alreadySent, ...seen]);
  return fresh;
}

/**
 * Rejoue l'anti-doublon en sens inverse : utile en mode dry-run pour ne pas
 * marquer les articles comme envoyés alors qu'on n'a rien envoyé.
 * @param {Array<object>} articles
 */
export function rollbackDuplicates(articles) {
  const alreadySent = new Set(readState());
  for (const article of articles) {
    alreadySent.delete(article.link);
  }
  writeState([...alreadySent]);
}
