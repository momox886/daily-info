import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const STATE_FILE = path.join(__dirname, '..', 'source-health.json');

/**
 * Lit l'état de santé des sources.
 * @returns {object} indexé par nom de source
 */
function loadState() {
  try {
    if (fs.existsSync(STATE_FILE)) {
      const data = JSON.parse(fs.readFileSync(STATE_FILE, 'utf-8'));
      return data.sources || {};
    }
  } catch (err) {
    console.error(`[health] Impossible de lire ${STATE_FILE} : ${err.message}`);
  }
  return {};
}

/**
 * Sauvegarde l'état de santé des sources.
 * @param {object} state
 */
function saveState(state) {
  try {
    fs.writeFileSync(STATE_FILE, JSON.stringify({ sources: state }, null, 2));
  } catch (err) {
    console.error(`[health] Impossible d'écrire ${STATE_FILE} : ${err.message}`);
  }
}

/**
 * Met à jour l'état de santé à partir des résultats du cycle et renvoie les
 * événements à notifier (sources en panne / de retour).
 * @param {Array<{name: string, ok: boolean, error?: string}>} statuses
 * @param {number} threshold nombre d'échecs consécutifs avant alerte
 * @returns {{alerts: Array<{name: string, failures: number, lastOk: string}>, recoveries: Array<string>}}
 */
export function recordSourceHealth(statuses, threshold = 3) {
  const state = loadState();
  const now = new Date().toISOString();
  const alerts = [];
  const recoveries = [];

  for (const status of statuses) {
    const prev = state[status.name] || {
      consecutiveFailures: 0,
      lastOk: null,
      lastFail: null,
      alerted: false,
    };

    if (status.ok) {
      // La source est saine : si elle était en panne, c'est un retour à la normale.
      if (prev.consecutiveFailures > 0) {
        recoveries.push(status.name);
      }
      state[status.name] = {
        consecutiveFailures: 0,
        lastOk: now,
        lastFail: prev.lastFail,
        alerted: false,
      };
    } else {
      const failures = prev.consecutiveFailures + 1;
      state[status.name] = {
        consecutiveFailures: failures,
        lastOk: prev.lastOk,
        lastFail: now,
        alerted: prev.alerted,
      };
      // Alerte une seule fois par "panne", après `threshold` échecs consécutifs.
      if (failures >= threshold && !prev.alerted) {
        state[status.name].alerted = true;
        alerts.push({ name: status.name, failures, lastOk: prev.lastOk });
      }
    }
  }

  saveState(state);
  return { alerts, recoveries };
}
