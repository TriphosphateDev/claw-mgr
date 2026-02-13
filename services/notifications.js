const fs = require('fs');
const path = require('path');

const NOTIFICATIONS_JSONL = 'notifications.jsonl';
const DISMISSED_JSON = 'notifications-dismissed.json';

function ensureDir(dir) {
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch {}
}

function readDismissed(baseDir) {
  const p = path.join(baseDir, DISMISSED_JSON);
  try {
    if (fs.existsSync(p)) {
      return JSON.parse(fs.readFileSync(p, 'utf8'));
    }
  } catch {}
  return { ids: [], beforeTs: null };
}

function writeDismissed(baseDir, data) {
  ensureDir(baseDir);
  fs.writeFileSync(path.join(baseDir, DISMISSED_JSON), JSON.stringify(data, null, 2), 'utf8');
}

function createNotificationsStore({ baseDir }) {
  const jsonlPath = path.join(baseDir, NOTIFICATIONS_JSONL);

  function add(entry) {
    ensureDir(baseDir);
    const id = `n_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
    const ts = Date.now();
    const record = {
      id,
      ts,
      level: entry.level || 'info',
      title: entry.title || '',
      body: entry.body || '',
      source: entry.source || '',
      meta: entry.meta || {},
    };
    fs.appendFileSync(jsonlPath, JSON.stringify(record) + '\n', 'utf8');
    return record;
  }

  function list({ limit = 50 } = {}) {
    let lines = [];
    try {
      if (fs.existsSync(jsonlPath)) {
        const raw = fs.readFileSync(jsonlPath, 'utf8');
        lines = raw.trim().split('\n').filter(Boolean);
      }
    } catch {}
    const dismissed = readDismissed(baseDir);
    const isDismissed = (r) =>
      dismissed.ids.includes(r.id) || (dismissed.beforeTs != null && r.ts < dismissed.beforeTs);
    const items = lines
      .map((line) => {
        try {
          return JSON.parse(line);
        } catch {
          return null;
        }
      })
      .filter(Boolean)
      .filter((r) => !isDismissed(r))
      .reverse()
      .slice(0, limit);
    return items;
  }

  function dismiss({ id, beforeTs } = {}) {
    const d = readDismissed(baseDir);
    if (id) d.ids.push(id);
    if (beforeTs != null) d.beforeTs = d.beforeTs == null ? beforeTs : Math.max(d.beforeTs, beforeTs);
    writeDismissed(baseDir, d);
    return { ok: true };
  }

  return { add, list, dismiss };
}

module.exports = { createNotificationsStore };
