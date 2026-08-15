# cyber-news-bot

Bot Node.js qui envoie chaque jour un résumé des actualités informatique / cybersécurité dans un salon Discord via un webhook.

Il récupère les derniers articles de plusieurs flux RSS, filtre ceux déjà publiés (anti-doublon), et envoie des embeds Discord (titre cliquable, source en footer, couleur selon la gravité).

## Fonctionnement

```
flux RSS → fetchNews.js → filterNews.js → sendDiscord.js → webhook Discord
             (récupération)   (date + mots-clés   (embeds, max 10
                              + anti-doublon)      par message)
```

1. **Récupération** : lit chaque flux de `config/sources.json` en parallèle (`rss-parser`). Si un flux échoue (et qu'un `fallbackUrl` est défini), il est réessayé ; sinon l'erreur est logguée et les autres sources continuent.
2. **Filtrage** : ne garde que les articles des dernières `LOOKBACK_HOURS` (24 par défaut), puis applique les filtres `INCLUDE_KEYWORDS` / `EXCLUDE_KEYWORDS`.
3. **Anti-doublon** : les liens déjà envoyés sont conservés dans `sent-articles.json`. Un lien déjà vu (ou présent dans plusieurs flux) n'est jamais re-envoyé.
4. **Envoi** : les articles sont regroupés en messages d'au plus 10 embeds (limite Discord). Les mots-clés prioritaires colorent l'embed en **rouge** (CVE, zero-day, exploit, vulnérabilité critique) ou **orange** (ransomware, faille), sinon **vert**.

## Prérequis

- Node.js ≥ 18 (le `fetch` intégré est utilisé)
- Un salon Discord + un webhook

## Installation

```bash
git clone <votre-repo> cyber-news-bot
cd cyber-news-bot
npm install
cp .env.example .env
```

## Créer un webhook Discord

1. Ouvrez le serveur Discord, cliquez sur l'engrenage **Paramètres** du salon cible.
2. Allez dans **Intégrations** → **Webhooks** → **Nouveau webhook**.
3. Donnez-lui un nom (ex : `Cyber News Bot`) et cliquez sur **Copier l'URL du webhook**.
4. Collez cette URL dans `.env` :

```
DISCORD_WEBHOOK_URL=https://discord.com/api/webhooks/<id>/<token>
```

> Le webhook est un lien sensible : toute personne qui le possède peut poster dans le salon. Ne le commitez jamais dans Git (`.env` est ignoré).

## Configuration (`.env`)

| Variable | Défaut | Description |
| --- | --- | --- |
| `DISCORD_WEBHOOK_URL` | — | **Obligatoire.** URL du webhook Discord |
| `LOOKBACK_HOURS` | `24` | Fenêtre de temps (heures) pour considérer un article comme récent |
| `INCLUDE_KEYWORDS` | *(vide)* | Ne garder que les articles contenant un de ces mots-clés (séparés par des virgules). Vide = tous |
| `EXCLUDE_KEYWORDS` | *(vide)* | Exclure les articles contenant un de ces mots-clés |
| `PRIORITY_KEYWORDS` | voir `.env.example` | Mots-clés de priorité (préfixe `!` = niveau critique) |
| `SCHEDULE_CRON` | `0 8 * * *` | Planification quotidienne (Europe/Paris) |
| `BOT_USERNAME` | `Cyber News Bot` | Nom affiché dans Discord |
| `BOT_ICON_URL` | *(vide)* | URL d'avatar du bot |
| `MAX_EMBEDS_PER_MESSAGE` | `10` | Nombre max d'embeds par message (max Discord : 10) |

## Utilisation

### One-shot (un cycle puis sortie) — recommandé pour cron / GitHub Actions

```bash
npm run daily
```

Code de sortie ≠ 0 en cas d'erreur (utile pour faire échouer un job CI).

### Mode démon (processus qui reste actif)

```bash
npm start
```

Lance un cycle immédiat au démarrage puis un cycle quotidien à l'heure de `SCHEDULE_CRON` via `node-cron` (fuseau Europe/Paris).

### Dry-run (test sans envoi Discord)

```bash
npm run dry-run
```

Affiche les articles qui seraient envoyés (titre, source, lien, couleur) sans rien poster, et ne marque rien comme envoyé.

## Planification automatique

### Option A — GitHub Actions (recommandé)

Le dépôt contient déjà `.github/workflows/daily-news.yml` qui tourne chaque jour à **06:00 UTC** (= 08:00 à Paris en hiver, 07:00 en été).

1. Poussez ce projet sur GitHub.
2. Onglet **Settings** → **Secrets and variables** → **Actions** → **New repository secret** :
   - Nom : `DISCORD_WEBHOOK_URL`
   - Valeur : l'URL du webhook
3. Le workflow s'exécutera automatiquement. L'anti-doublon (`sent-articles.json`) est conservé d'une exécution à l'autre via le cache GitHub.
4. Vous pouvez aussi déclencher une exécution manuelle : onglet **Actions** → **daily-news** → **Run workflow**.

> Les crons GitHub sont en **UTC** : pour viser 08:00 heure de Paris toute l'année il faudrait deux entrées (06:00 UTC en hiver, 07:00 UTC en été), le workflow n'en retient qu'une par simplicité.

### Option B — cron système

Exemple avec `crontab -e` pour une exécution quotidienne à 08:00 (heure locale) :

```
0 8 * * * cd /chemin/vers/cyber-news-bot && /usr/bin/node src/index.js --once >> logs/cron.log 2>&1
```

### Option C — système de tuiles / timers (systemd)

Un `.timer` systemd peut aussi appeler `npm run daily` chaque jour.

## Ajouter / retirer une source RSS

Éditez `config/sources.json` : ajoutez simplement un objet. C'est tout, aucun code à changer.

```json
{
  "name": "Ma Source",
  "url": "https://exemple.com/feed.xml",
  "fallbackUrl": "https://exemple.com/feed-secours.xml",  // optionnel
  "category": "cybersec"
}
```

- `category` est purement informatif (`cybersec`, `cert`, `it`, ...).
- `fallbackUrl` (optionnel) : si `url` échoue, le bot tente cette URL avant d'abandonner.

### Note sur ZDNet

L'URL du flux « sécurité » de ZDNet renvoie actuellement une page HTML au lieu d'un flux RSS ; le bot bascule automatiquement sur le flux général de ZDNet (`fallbackUrl`). Surveillez que ce flux ne contienne pas d'articles hors sujet sécurité.

## Logs

Chaque exécution écrit dans `logs/cyber-news-bot.log` et dans la console : nombre d'articles trouvés, filtrés, déjà vus, envoyés, et erreurs par source.

## Structure du projet

```
cyber-news-bot/
├── config/
│   └── sources.json          # liste des flux RSS
├── src/
│   ├── fetchNews.js          # récupération RSS + normalisation des dates
│   ├── filterNews.js         # filtre par date / mots-clés / anti-doublon
│   ├── sendDiscord.js        # construction et envoi des embeds Discord
│   ├── logger.js             # logs console + fichier
│   └── index.js              # orchestration + modes (one-shot / démon / dry-run)
├── .github/workflows/
│   └── daily-news.yml        # planification GitHub Actions
├── .env.example              # exemple de configuration
└── package.json              # scripts start / daily / dry-run
```
