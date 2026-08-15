# cyber-news-bot

Bot Node.js qui envoie chaque jour un résumé des actualités informatique / cybersécurité dans un salon Discord via un webhook.

Il récupère les derniers articles de plusieurs flux RSS, filtre ceux déjà publiés (anti-doublon), et envoie des embeds Discord (titre cliquable, source en footer, couleur selon la gravité).

## Fonctionnement

```
flux RSS → fetchNews.js → filterNews.js → summarize.js → sendDiscord.js → webhook Discord
             (récupération)   (date + mots-clés   (résumé LLM      (À la une + embeds,
              + images)        + anti-doublon)      + pertinence)     max 10/message)
                            → sourceHealth.js
                              (alertes sources en panne)
```

1. **Récupération** : lit chaque flux de `config/sources.json` (14 sources : THN, BleepingComputer, Krebs, Dark Reading, CERT-FR, ZDNet, The Record, CISA, Help Net Security, Malwarebytes, Schneier, The Register, CSO...) en parallèle (`rss-parser`). Si un flux échoue (et qu'un `fallbackUrl` est défini), il est réessayé ; sinon l'erreur est logguée et les autres sources continuent. Une **image** d'illustration est extraite de l'élément RSS quand elle existe (thumbnail dans l'embed).
2. **Filtrage** : ne garde que les articles des dernières `LOOKBACK_HOURS` (24 par défaut), puis applique les filtres `INCLUDE_KEYWORDS` / `EXCLUDE_KEYWORDS`.
3. **Anti-doublon** : les liens déjà envoyés sont conservés dans `sent-articles.json`. Un lien déjà vu (ou présent dans plusieurs flux) n'est jamais re-envoyé.
4. **Résumé LLM** (optionnel, Groq) : chaque article reçoit un résumé de 1-2 phrases en français, des **détails techniques** (CVE, CVSS, produit/version affectés, vecteur, IoC), une note de pertinence (1-10), une **gravité** (critical/high/medium/low) et un flag « à lire en entier ». Les articles couvrant le **même sujet** sont fusionnés (seule la meilleure source est gardée) puis classés du plus pertinent au moins pertinent.
5. **Santé des sources** : l'état de chaque flux est suivi dans `source-health.json`. Une source qui échoue `SOURCE_ALERT_THRESHOLD` fois de suite déclenche une **alerte Discord** (avec la date de son dernier succès) ; son retour à la normale est aussi annoncé.
6. **Envoi** : un **marqueur de séparation** (`════ 🆕 Articles du jour — N ════`) démarque le nouveau lot des articles déjà postés, suivi d'un **bandeau récapitulatif** (date, nombre d'articles, santé des sources). Le message **« À la une du jour »** présente les `TOP_N` meilleurs articles (texte cliquable + résumé + thumbnail si image), puis les autres partent en embeds (max 10 par message) sous un séparateur **« Autres articles »**. La couleur de l'embed suit la **gravité LLM** (rouge = critical, orange = high, vert sinon) et un **emoji de gravité** (🔴🟠🟡🟢) est ajouté au titre ; les mots-clés CVE/ransomware/faille servent de repli sans LLM. Les articles à lire en entier portent un badge **⭐**.

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
| `GROQ_API_KEY` | *(vide)* | Clé API Groq gratuite (résumés LLM). Vide = envoi sans résumés |
| `LLM_MODEL` | `llama-3.3-70b-versatile` | Modèle Groq utilisé |
| `ENABLE_SUMMARIZATION` | `true` | Activer/désactiver le résumé LLM |
| `MAX_ARTICLES_TO_SUMMARIZE` | `15` | Nombre max d'articles résumés par cycle (quota free tier) |
| `ENABLE_SMART_DEDUP` | `true` | Fusionner les articles couvrant le même sujet (une seule source gardée) |
| `ENABLE_TOP3` | `true` | Afficher un message « À la une » en tête du digest |
| `TOP_N` | `3` | Nombre d'articles dans le message « À la une » |
| `ENABLE_SOURCE_ALERTS` | `true` | Alerter sur Discord quand une source RSS échoue plusieurs fois de suite |
| `SOURCE_ALERT_THRESHOLD` | `3` | Nombre d'échecs consécutifs avant l'alerte |
| `ENABLE_DAY_BANNER` | `true` | Marqueur de séparation + bandeau récapitulatif en tête du digest |
| `SCHEDULE_CRON` | `0 8 * * *` | Planification quotidienne (Europe/Paris) |
| `BOT_USERNAME` | `Cyber News Bot` | Nom affiché dans Discord |
| `BOT_ICON_URL` | *(vide)* | URL d'avatar du bot |
| `MAX_EMBEDS_PER_MESSAGE` | `10` | Nombre max d'embeds par message (max Discord : 10) |

## Résumé LLM (Groq free tier)

Le bot peut faire résumer chaque article par un LLM gratuit et classer le digest du plus pertinent au moins pertinent, avec un badge **⭐ À lire en entier** sur les articles qui valent le détour.

1. Créez un compte gratuit sur **https://console.groq.com** (connexion Google/GitHub).
2. Allez dans **API Keys** → **Create API Key**, copiez la clé (`gsk_...`).
3. Mettez-la dans `.env` :
   ```
   GROQ_API_KEY=gsk_xxxxxxxxxxxx
   ```

Le modèle par défaut `llama-3.3-70b-versatile` est gratuit (quota ≈ 14 400 tokens/jour, soit ~12 résumés/jour). Si le LLM échoue ou si la clé est absente, le bot envoie quand même les articles (sans résumé) — le résumé ne bloque jamais l'envoi.

Le LLM fournit par article : un **résumé** en français, des **détails techniques** (CVE, CVSS, produit affecté, vecteur, IoC), une **note de pertinence** (1-10), une **gravité** (critical/high/medium/low), et un **identifiant de sujet** utilisé pour :
- **fusionner les doublons** : si deux sources (ex : The Hacker News + BleepingComputer) couvrent le même incident, une seule est conservée (la mieux notée) ;
- **le message « À la une »** : les `TOP_N` meilleurs articles du jour en tête du digest.

Testez avec `npm run dry-run` : la sortie affiche le résumé, les détails techniques, la note, la gravité, la liste des doublons fusionnés et le contenu du message « À la une », sans rien poster sur Discord.

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
   - `DISCORD_WEBHOOK_URL` : l'URL du webhook
   - `GROQ_API_KEY` : la clé Groq (pour les résumés LLM)
3. Le workflow s'exécutera automatiquement. L'anti-doublon (`sent-articles.json`) et l'état de santé des sources (`source-health.json`) sont **committés dans le repo** à chaque exécution : contrairement au cache GitHub (expiré après 7 jours), l'état persiste indéfiniment et évite les doublons d'une exécution à l'autre.
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
- L'**image** de l'article est extraite automatiquement des champs `media:thumbnail`, `media:content` ou `enclosure` du flux quand ils existent ; elle apparaît en miniature dans l'embed (ignorée si l'URL n'est pas une image valide).

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
│   ├── fetchNews.js          # récupération RSS + normalisation des dates + images
│   ├── filterNews.js         # filtre par date / mots-clés / anti-doublon
│   ├── summarize.js          # résumé LLM Groq + note de pertinence + classement
│   ├── sourceHealth.js       # suivi des sources en panne + alertes Discord
│   ├── sendDiscord.js        # construction et envoi des embeds Discord
│   ├── logger.js             # logs console + fichier
│   └── index.js              # orchestration + modes (one-shot / démon / dry-run)
├── .github/workflows/
│   └── daily-news.yml        # planification GitHub Actions
├── .env.example              # exemple de configuration
└── package.json              # scripts start / daily / dry-run
```
