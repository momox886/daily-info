// Client LLM gratuit via l'API Groq (compatible OpenAI).
// Pour chaque article : résumé en français, détails techniques, note de
// pertinence, gravité, flag "à lire en entier" et identifiant de sujet.
// Fusionne les articles couvrant le même sujet (dédoublonnage intelligent)
// puis ordonne du plus pertinent au moins pertinent.

const DEFAULT_MODEL = 'qwen/qwen3.8-27b';
const DEFAULT_BASE_URL = 'https://api.groq.com/openai/v1';
const DEFAULT_MAX_ARTICLES = 12; // limite des résumés par cycle (quotas free tier)

const SYSTEM_PROMPT = `
Tu es un analyste cybersécurité expérimenté qui prépare un digest quotidien
pour des professionnels de l'informatique francophones.

On te fournit une liste JSON d'articles : [{"index", "title", "description", "source", "category"}].

Pour CHAQUE article, réponds avec :
- "summary" : un résumé de 1 à 2 phrases en FRANÇAIS, objectif et factuel.
- "technicalDetails" : les détails techniques essentiels en FRANÇAIS (CVE, score
  CVSS, produit/logiciel affecté et version, vecteur d'attaque, type de faille,
  indicateurs de compromission, correctif...) quand ils sont mentionnés dans
  l'article. Une phrase courte max, ou une chaîne vide s'il n'y a rien.
- "relevance" : un entier de 1 à 10 mesurant la pertinence pour un
  professionnel de la cybersécurité (10 = indispensable, 1 = hors sujet).
  Un article hors sujet informatique/cyber doit recevoir une note basse.
- "severity" : la gravité, une de : "critical", "high", "medium", "low".
- "worthFullRead" : true si l'article mérite d'être lu en entier (incident
  majeur, technique approfondie, recommandations exploitables), sinon false.
- "storyId" : un identifiant court et stable du SUJET couvert (ex:
  "cve-2026-55040-sharepoint", "ransomware-europe-2026-08"). Tous les articles
  traitant de la MÊME affaire/incident doivent avoir le MÊME storyId ; deux
  articles sur des sujets différents doivent avoir des storyId différents.

Réponds STRICTEMENT en JSON valide, sans texte autour, au format :
{"articles":[{"index":0,"summary":"...","technicalDetails":"...","relevance":8,"severity":"high","worthFullRead":true,"storyId":"..."}]}
`;

/**
 * Extrait et parse un objet JSON à partir d'une réponse texte (robuste :
 * tolère des sauts de ligne ou un bloc de code ```json ... ```).
 * @param {string} text
 * @returns {object|null}
 */
function extractJson(text) {
  if (!text) return null;
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidate = fenced ? fenced[1] : text;
  const start = candidate.indexOf('{');
  const end = candidate.lastIndexOf('}');
  if (start === -1 || end === -1) return null;
  try {
    return JSON.parse(candidate.slice(start, end + 1));
  } catch {
    return null;
  }
}

/**
 * Garde le meilleur article de chaque groupe de sujets (même storyId) et
 * renvoie les articles écartés.
 * Critère de sélection : pertinence la plus haute, puis "à lire en entier",
 * puis description la plus longue.
 * @param {Array<object>} articles
 * @param {boolean} enabled
 * @returns {{kept: Array<object>, dropped: Array<object>}}
 */
function dedupeByStory(articles, enabled = true) {
  if (!enabled) return { kept: articles, dropped: [] };

  const groups = new Map();
  for (const article of articles) {
    const storyId = typeof article.storyId === 'string' && article.storyId.trim()
      ? article.storyId.trim().toLowerCase()
      : null;
    if (!storyId) {
      // Pas d'identifiant : article conservé tel quel.
      continue;
    }
    if (!groups.has(storyId)) groups.set(storyId, []);
    groups.get(storyId).push(article);
  }

  // Articles sans storyId ou en groupe de 1 : toujours conservés.
  const withoutGroup = articles.filter((a) => {
    const storyId = typeof a.storyId === 'string' && a.storyId.trim()
      ? a.storyId.trim().toLowerCase()
      : null;
    return !storyId || (groups.get(storyId) || []).length < 2;
  });

  const kept = [...withoutGroup];
  const dropped = [];

  for (const [, group] of groups) {
    if (group.length < 2) continue;
    const pickBest = (x, y) => {
      const rx = typeof x.relevance === 'number' ? x.relevance : -1;
      const ry = typeof y.relevance === 'number' ? y.relevance : -1;
      if (rx !== ry) return rx > ry ? x : y;
      if (x.highlight !== y.highlight) return x.highlight ? x : y;
      return (x.description || '').length >= (y.description || '').length ? x : y;
    };
    const best = group.reduce(pickBest);
    kept.push(best);
    for (const article of group) {
      if (article !== best) dropped.push(article);
    }
  }

  return { kept, dropped };
}

/**
 * Appelle Groq pour résumer, noter et dédoublonner les articles.
 * En cas d'échec, renvoie les articles inchangés (l'envoi ne doit jamais
 * être bloqué par le LLM).
 * @param {Array<object>} articles
 * @param {object} env
 * @returns {Promise<{articles: Array<object>, dropped: Array<object>}>}
 *   articles : enrichis, dédoublonnés et triés par pertinence décroissante.
 *   dropped  : articles fusionnés avec un autre traitant du même sujet.
 */
export async function summarizeArticles(articles, env = process.env) {
  const apiKey = env.GROQ_API_KEY || env.LLM_API_KEY;
  if (!apiKey) {
    throw new Error('GROQ_API_KEY manquant dans .env — résumés désactivés');
  }

  const baseUrl = env.GROQ_BASE_URL || DEFAULT_BASE_URL;
  const model = env.LLM_MODEL || DEFAULT_MODEL;
  const max = Number(env.MAX_ARTICLES_TO_SUMMARIZE) || DEFAULT_MAX_ARTICLES;
  const batch = articles.slice(0, max).map((a, i) => ({
    index: i,
    title: a.title,
    description: (a.description || '').slice(0, 300),
    source: a.source,
    category: a.category,
  }));

  const res = await fetch(`${baseUrl.replace(/\/$/, '')}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      temperature: 0.2,
      max_tokens: 2048,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: JSON.stringify(batch) },
      ],
    }),
  });

  if (!res.ok) {
    const detail = await res.text();
    throw new Error(`Groq a répondu ${res.status} : ${detail.slice(0, 300)}`);
  }

  const data = await res.json();
  const content = data.choices?.[0]?.message?.content;
  const parsed = extractJson(content);
  const results = parsed?.articles;
  if (!Array.isArray(results) || results.length === 0) {
    throw new Error('Groq a renvoyé une réponse JSON inexploitable');
  }

  // Associe chaque résultat au bon article (par index). Les articles non
  // résumés (au-delà du quota max) restent tels quels.
  const byIndex = new Map(results.map((r) => [r.index, r]));
  const enriched = articles.map((article, i) => {
    const result = byIndex.get(i);
    if (!result || typeof result.relevance !== 'number') return article;
    return {
      ...article,
      summary: typeof result.summary === 'string' ? result.summary.trim().slice(0, 500) : '',
      technicalDetails: typeof result.technicalDetails === 'string'
        ? result.technicalDetails.trim().slice(0, 400)
        : '',
      severity: ['critical', 'high', 'medium', 'low'].includes(result.severity)
        ? result.severity
        : undefined,
      storyId: typeof result.storyId === 'string' ? result.storyId.trim() : undefined,
      relevance: result.relevance,
      highlight: Boolean(result.worthFullRead),
    };
  });

  // Dédoublonnage intelligent : ne garde que le meilleur article par sujet.
  const smartDedupEnabled = String(env.ENABLE_SMART_DEDUP ?? 'true').toLowerCase() === 'true';
  const { kept, dropped } = dedupeByStory(enriched, smartDedupEnabled);

  // Tri par pertinence décroissante (les non résumés restent à la fin).
  const sorted = [...kept].sort((a, b) => {
    const ra = typeof a.relevance === 'number' ? a.relevance : -1;
    const rb = typeof b.relevance === 'number' ? b.relevance : -1;
    return rb - ra;
  });

  return { articles: sorted, dropped };
}
