const express = require('express');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawn } = require('child_process');
const { getDashboardSummary } = require('./services/openclawStatus');
const { readJobs, readRuns, runNow } = require('./services/openclawCron');
const { createNotificationsStore } = require('./services/notifications');
const { appendActivity } = require('./services/activityLog');
const { gatewayCall } = require('./services/openclawGatewayCall');

const app = express();
const PORT = Number(process.env.PORT) || 8011;
const isWindows = process.platform === 'win32';

// Self version (from package.json)
const pkg = require('./package.json');
const CURRENT_VERSION = pkg.version || '0.0.0';
const GITHUB_RAW_PKG = 'https://raw.githubusercontent.com/Ascendism/claw-mgr/main/package.json';
const VERSION_CACHE_MS = 10 * 60 * 1000; // 10 min
let versionCheckCache = { result: null, at: 0 };

function parseVersion(s) {
  if (!s || typeof s !== 'string') return [0, 0, 0];
  const parts = s.replace(/^v/, '').split('.').map((n) => parseInt(n, 10) || 0);
  return [parts[0] || 0, parts[1] || 0, parts[2] || 0];
}

function compareVersions(a, b) {
  const va = parseVersion(a);
  const vb = parseVersion(b);
  for (let i = 0; i < 3; i++) {
    if (va[i] > vb[i]) return 1;
    if (va[i] < vb[i]) return -1;
  }
  return 0;
}

async function fetchLatestVersion() {
  try {
    const r = await fetch(GITHUB_RAW_PKG, { signal: AbortSignal.timeout(5000) });
    if (!r.ok) return null;
    const data = await r.json();
    return data.version || null;
  } catch {
    return null;
  }
}
const workspaceRoot = path.join(__dirname, '..');
const CONFIG_PATH = path.join(workspaceRoot, 'startup-config.json');
const OPENCLAW_CONFIG_PATH = path.join(os.homedir(), '.openclaw', 'openclaw.json');
const STATE_PATH = path.join(__dirname, '.claw-mgr-state.json');
const MEMORY_DIR = path.join(workspaceRoot, 'memory');
const HEARTBEAT_STATE_PATH = path.join(MEMORY_DIR, 'heartbeat-state.json');
// cron jobs are handled via services/openclawCron.js
const GATEWAY_URL = process.env.OPENCLAW_GATEWAY_URL || 'http://127.0.0.1:18789';

// Local notifications store (append-only JSONL + dismiss state)
const NOTIFICATIONS_DIR = path.join(__dirname, 'data');
const notifications = createNotificationsStore({ baseDir: NOTIFICATIONS_DIR });

// --- Notification triggers (high-signal only; state-change driven) ---
const NOTIFY_WATCH_STATE_PATH = path.join(NOTIFICATIONS_DIR, 'notify-watch.json');
const NOTIFY_POLL_MS = Number(process.env.CLAW_MGR_NOTIFY_POLL_MS || 30000);
const HEARTBEAT_MISS_MS = Number(process.env.CLAW_MGR_HEARTBEAT_MISS_MS || 60 * 60 * 1000); // 60m

function readJsonSafe(filePath, fallback) {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return fallback;
  }
}

function writeJsonSafe(filePath, obj) {
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify(obj, null, 2), 'utf8');
  } catch {}
}

function getWatchState() {
  return readJsonSafe(NOTIFY_WATCH_STATE_PATH, {
    gatewayUp: null,
    lastHeartbeatAt: null,
    heartbeatMissNotifiedAt: null,
    lastCronRunTsByJobId: {},
    coreFiles: {},
  });
}

function setWatchState(next) {
  writeJsonSafe(NOTIFY_WATCH_STATE_PATH, next);
}

async function checkGatewayTransition() {
  const base = GATEWAY_URL.replace(/\/$/, '');
  let up = false;
  try {
    const healthRes = await fetch(`${base}/health`, { signal: AbortSignal.timeout(3000) });
    up = !!healthRes.ok;
  } catch {
    up = false;
  }

  const s = getWatchState();
  if (s.gatewayUp === null) {
    s.gatewayUp = up;
    setWatchState(s);
    return;
  }

  if (up !== s.gatewayUp) {
    s.gatewayUp = up;
    setWatchState(s);
    try {
      notifications.add({
        level: up ? 'info' : 'warn',
        title: up ? 'Gateway is up' : 'Gateway is down',
        body: up ? 'OpenClaw gateway responded to /health.' : `Could not reach ${base}/health`,
        source: 'watch',
        meta: { kind: 'gateway', up },
      });
    } catch {}
    try {
      appendActivity({ memoryDir: MEMORY_DIR, line: `Gateway ${up ? 'up' : 'down'} (watch)` });
    } catch {}
  }
}

function checkHeartbeatMiss() {
  const s = getWatchState();

  let lastHeartbeatAt = null;
  try {
    if (fs.existsSync(HEARTBEAT_STATE_PATH)) {
      const data = JSON.parse(fs.readFileSync(HEARTBEAT_STATE_PATH, 'utf8'));
      lastHeartbeatAt = data?.lastHeartbeatAt || null;
    }
  } catch {
    lastHeartbeatAt = null;
  }

  if (lastHeartbeatAt && lastHeartbeatAt !== s.lastHeartbeatAt) {
    s.lastHeartbeatAt = lastHeartbeatAt;
    // reset miss notification if heartbeat comes back
    s.heartbeatMissNotifiedAt = null;
    setWatchState(s);
    return;
  }

  // No heartbeat recorded yet
  if (!lastHeartbeatAt) {
    setWatchState(s);
    return;
  }

  const age = Date.now() - Number(lastHeartbeatAt);
  if (age > HEARTBEAT_MISS_MS && !s.heartbeatMissNotifiedAt) {
    s.heartbeatMissNotifiedAt = Date.now();
    setWatchState(s);
    try {
      notifications.add({
        level: 'warn',
        title: 'Heartbeat missed',
        body: `No heartbeat for ~${Math.round(age / 60000)} minutes.`,
        source: 'watch',
        meta: { kind: 'heartbeat', lastHeartbeatAt },
      });
    } catch {}
    try {
      appendActivity({ memoryDir: MEMORY_DIR, line: `Heartbeat missed (~${Math.round(age / 60000)}m)` });
    } catch {}
  }
}

function isRunFailure(run) {
  if (!run || typeof run !== 'object') return false;
  const st = String(run.status || '').toLowerCase();
  if (st && st !== 'ok') return true;
  const summary = String(run.summary || '');
  if (/\bfailed\b/i.test(summary)) return true;
  if (summary.includes('⚠️')) return true;
  return false;
}

function checkCronFailures() {
  const jobs = readJobs();
  const s = getWatchState();
  const lastByJob = s.lastCronRunTsByJobId && typeof s.lastCronRunTsByJobId === 'object' ? s.lastCronRunTsByJobId : {};

  for (const j of jobs) {
    const jobId = j.jobId || j.id;
    if (!jobId) continue;

    const runs = readRuns(jobId, 1);
    const latest = Array.isArray(runs) && runs.length ? runs[0] : null;
    const latestTs = latest ? Number(latest.ts || latest.runAtMs || 0) : 0;
    if (!latestTs) continue;

    const prevTs = Number(lastByJob[jobId] || 0);
    if (latestTs <= prevTs) continue; // already processed

    lastByJob[jobId] = latestTs;
    s.lastCronRunTsByJobId = lastByJob;
    setWatchState(s);

    if (isRunFailure(latest)) {
      const name = j.name || jobId;
      const summary = String(latest.summary || '').trim();
      try {
        notifications.add({
          level: 'warn',
          title: 'Cron job issue',
          body: `${name}: ${summary || 'latest run flagged as warning/failure'}`,
          source: 'watch',
          meta: { kind: 'cron', jobId, status: latest.status || null },
        });
      } catch {}
      try {
        appendActivity({ memoryDir: MEMORY_DIR, line: `Cron issue (${name})` });
      } catch {}
    }
  }
}

function fileStamp(filePath) {
  try {
    const st = fs.statSync(filePath);
    return `${st.mtimeMs}|${st.size}`;
  } catch {
    return null;
  }
}

function checkCoreFileChanges() {
  const s = getWatchState();
  const core = (s.coreFiles && typeof s.coreFiles === 'object') ? s.coreFiles : {};

  const files = [
    'AGENTS.md',
    'SOUL.md',
    'IDENTITY.md',
    'USER.md',
    'HEARTBEAT.md',
    'TOOLS.md',
  ];

  let changed = false;
  for (const name of files) {
    const p = path.join(workspaceRoot, name);
    const stamp = fileStamp(p);
    const prev = core[name];

    // Baseline on first sight; don't notify.
    if (prev == null) {
      core[name] = stamp;
      changed = true;
      continue;
    }

    if (stamp !== prev) {
      core[name] = stamp;
      changed = true;
      try {
        notifications.add({
          level: 'info',
          title: 'Core file changed',
          body: `${name} was modified.`,
          source: 'watch',
          meta: { kind: 'file', file: name, path: p },
        });
      } catch {}
      try {
        appendActivity({ memoryDir: MEMORY_DIR, line: `File changed: ${name}` });
      } catch {}
    }
  }

  if (changed) {
    s.coreFiles = core;
    setWatchState(s);
  }
}

// Fire-and-forget poller; only emits notifications on state transitions.
setInterval(() => {
  checkGatewayTransition().catch(() => {});
  try { checkHeartbeatMiss(); } catch {}
  try { checkCronFailures(); } catch {}
  try { checkCoreFileChanges(); } catch {}
}, NOTIFY_POLL_MS);

app.use(express.json());

// Serve Vue from node_modules with correct MIME type (no CDN/fetch)
const vuePath = path.join(__dirname, 'node_modules', 'vue', 'dist', 'vue.min.js');
app.get('/vendor/vue.global.prod.js', (req, res) => {
  res.type('application/javascript');
  res.sendFile(vuePath, (err) => {
    if (err) res.status(500).send('// Vue not found. Run: npm install');
  });
});

async function fetchOllamaModels() {
  try {
    const r = await fetch('http://127.0.0.1:11434/api/tags', { signal: AbortSignal.timeout(3000) });
    if (!r.ok) return [];
    const data = await r.json();
    return (data.models || []).map((m) => ({
      id: m.name.includes('/') ? m.name : `ollama/${m.name}`,
      name: m.name,
    }));
  } catch {
    return [];
  }
}

// Serve index with Ollama models preloaded so the UI has the list before Vue mounts
const indexPath = path.join(__dirname, 'public', 'index.html');
const PRELOAD_PLACEHOLDER = 'window.__OLLAMA_MODELS__ = [];';
const REMOTE_PROVIDERS_PLACEHOLDER = 'window.__REMOTE_PROVIDERS__ = [];';
const SERVED_FROM_PLACEHOLDER = '<!-- __SERVED_FROM__ -->';

app.get('/', async (req, res) => {
  const models = await fetchOllamaModels();
  let html = fs.readFileSync(indexPath, 'utf8');
  html = html.replace(PRELOAD_PLACEHOLDER, `window.__OLLAMA_MODELS__ = ${JSON.stringify(models)};`);
  html = html.replace(REMOTE_PROVIDERS_PLACEHOLDER, `window.__REMOTE_PROVIDERS__ = ${JSON.stringify(REMOTE_PROVIDERS_LIST)};`);
  html = html.replace(SERVED_FROM_PLACEHOLDER, `<!-- served from: ${indexPath} -->`);
  res.set({
    'Cache-Control': 'no-store, no-cache, must-revalidate',
    Pragma: 'no-cache',
    Expires: '0',
  });
  res.type('html').send(html);
});
app.get('/index.html', async (req, res) => {
  const models = await fetchOllamaModels();
  let html = fs.readFileSync(indexPath, 'utf8');
  html = html.replace(PRELOAD_PLACEHOLDER, `window.__OLLAMA_MODELS__ = ${JSON.stringify(models)};`);
  html = html.replace(REMOTE_PROVIDERS_PLACEHOLDER, `window.__REMOTE_PROVIDERS__ = ${JSON.stringify(REMOTE_PROVIDERS_LIST)};`);
  html = html.replace(SERVED_FROM_PLACEHOLDER, `<!-- served from: ${indexPath} -->`);
  res.set({
    'Cache-Control': 'no-store, no-cache, must-revalidate',
    Pragma: 'no-cache',
    Expires: '0',
  });
  res.type('html').send(html);
});

app.use(express.static(path.join(__dirname, 'public')));

function readState() {
  try {
    const raw = fs.readFileSync(STATE_PATH, 'utf8');
    return JSON.parse(raw);
  } catch {
    return { gatewayPid: null, dashboardPid: null, model: null, mode: null };
  }
}

function writeState(state) {
  fs.writeFileSync(STATE_PATH, JSON.stringify(state, null, 2), 'utf8');
}

function patchOpenClawModel(model) {
  if (!fs.existsSync(OPENCLAW_CONFIG_PATH)) return { ok: false, message: 'No openclaw.json' };
  try {
    let raw = fs.readFileSync(OPENCLAW_CONFIG_PATH, 'utf8');
    let data;
    try {
      data = JSON.parse(raw);
    } catch {
      raw = raw.replace(/\/\/[^\n]*/g, '').replace(/,(\s*[}\]])/g, '$1');
      data = JSON.parse(raw);
    }
    if (!data.agents) data.agents = {};
    if (!data.agents.defaults) data.agents.defaults = {};
    if (typeof data.agents.defaults.model !== 'object' || data.agents.defaults.model === null) {
      data.agents.defaults.model = { primary: model };
    } else {
      data.agents.defaults.model.primary = model;
    }
    fs.writeFileSync(OPENCLAW_CONFIG_PATH, JSON.stringify(data, null, 2), 'utf8');
    return { ok: true };
  } catch (e) {
    return { ok: false, message: e.message };
  }
}

// GET /api/ollama-models — list models from Ollama API (used by refresh)
app.get('/api/ollama-models', async (req, res) => {
  const models = await fetchOllamaModels();
  res.json({ models });
});

// --- Subagents (Gateway RPC proxy) ---
// These endpoints let the ClawMGR UI work with OpenClaw subagents without shelling out to the CLI.

app.get('/api/sessions', async (req, res) => {
  try {
    const limit = req.query.limit != null ? Number(req.query.limit) : 30;
    const activeMinutes = req.query.activeMinutes != null ? Number(req.query.activeMinutes) : 60;
    // Gateway method naming uses dots (Control UI convention).
    const out = await gatewayCall('sessions.list', { limit, activeMinutes });
    if (!out.ok) return res.status(500).json(out);
    res.json({ ok: true, result: out.result });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.post('/api/sessions/spawn', async (req, res) => {
  try {
    const { task, label, agentId, model, thinking, runTimeoutSeconds, cleanup } = req.body || {};
    if (!task || typeof task !== 'string') {
      return res.status(400).json({ ok: false, error: 'Missing task (string)' });
    }

    const params = { task, cleanup: cleanup || 'keep' };
    if (label) params.label = label;
    if (agentId) params.agentId = agentId;
    if (model) params.model = model;
    if (thinking) params.thinking = thinking;
    if (runTimeoutSeconds) params.runTimeoutSeconds = runTimeoutSeconds;

    const out = await gatewayCall('sessions.spawn', params);
    if (!out.ok) return res.status(500).json(out);
    res.json({ ok: true, result: out.result });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.get('/api/sessions/:sessionKey/history', async (req, res) => {
  try {
    const sessionKey = req.params.sessionKey;
    const limit = req.query.limit != null ? Number(req.query.limit) : 50;
    const includeTools = String(req.query.includeTools || '').toLowerCase() === 'true';

    const out = await gatewayCall('sessions.history', { sessionKey, limit, includeTools });
    if (!out.ok) return res.status(500).json(out);
    res.json({ ok: true, result: out.result });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// Deletes the session entry (and optionally transcript). Control UI uses this to clean up sessions.
app.post('/api/sessions/:sessionKey/delete', async (req, res) => {
  try {
    const sessionKey = req.params.sessionKey;
    const { deleteTranscript } = req.body || {};
    const out = await gatewayCall('sessions.delete', {
      key: sessionKey,
      deleteTranscript: deleteTranscript !== false, // default true
    });
    if (!out.ok) return res.status(500).json(out);
    res.json({ ok: true, result: out.result });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// Remote provider list: models are { id, ctx } where ctx = context window (e.g. "128K", "1M")
const REMOTE_PROVIDERS_LIST = [
  { id: 'xai', label: 'xAI (Grok)', envKey: 'XAI_API_KEY', models: [
    { id: 'grok-2', ctx: '128K' }, { id: 'grok-2-mini', ctx: '128K' }, { id: 'grok-2-vision-preview', ctx: '128K' },
    { id: 'grok-3', ctx: '1M' }, { id: 'grok-3-mini', ctx: '1M' }, { id: 'grok-3-fast', ctx: '1M' },
  ] },
  { id: 'openai', label: 'OpenAI', envKey: 'OPENAI_API_KEY', models: [
    { id: 'gpt-4o', ctx: '128K' }, { id: 'gpt-4o-mini', ctx: '128K' }, { id: 'gpt-4.1', ctx: '1M' },
    { id: 'gpt-4-turbo', ctx: '128K' }, { id: 'gpt-5.1-codex', ctx: '1M' }, { id: 'o1', ctx: '200K' }, { id: 'o1-mini', ctx: '200K' },
  ] },
  { id: 'anthropic', label: 'Anthropic', envKey: 'ANTHROPIC_API_KEY', models: [
    { id: 'claude-opus-4-6', ctx: '200K' }, { id: 'claude-sonnet-4-5', ctx: '200K' },
    { id: 'claude-3-5-sonnet-20241022', ctx: '200K' }, { id: 'claude-3-5-haiku', ctx: '200K' },
  ] },
  { id: 'openrouter', label: 'OpenRouter', envKey: 'OPENROUTER_API_KEY', models: [
    { id: 'anthropic/claude-sonnet-4-5', ctx: '200K' }, { id: 'openai/gpt-4o', ctx: '128K' },
    { id: 'google/gemini-2.0-flash', ctx: '1M' }, { id: 'meta-llama/llama-3.3-70b-instruct', ctx: '128K' },
  ] },
  { id: 'google', label: 'Google (Gemini)', envKey: 'GEMINI_API_KEY', models: [
    { id: 'gemini-2.0-flash', ctx: '1M' }, { id: 'gemini-2.5-pro-preview', ctx: '1M' }, { id: 'gemini-3-pro-preview', ctx: '1M' },
  ] },
  { id: 'groq', label: 'Groq', envKey: 'GROQ_API_KEY', models: [
    { id: 'llama-3.3-70b-versatile', ctx: '128K' }, { id: 'llama-3.1-70b-versatile', ctx: '128K' },
    { id: 'llama-3.1-8b-instant', ctx: '128K' }, { id: 'mixtral-8x7b-32768', ctx: '32K' },
  ] },
  { id: 'mistral', label: 'Mistral', envKey: 'MISTRAL_API_KEY', models: [
    { id: 'mistral-large-latest', ctx: '128K' }, { id: 'mistral-small-latest', ctx: '33K' }, { id: 'codestral-latest', ctx: '128K' },
  ] },
  { id: 'cerebras', label: 'Cerebras', envKey: 'CEREBRAS_API_KEY', models: [
    { id: 'llama-3.3-70b', ctx: '128K' }, { id: 'llama-3.1-8b', ctx: '32K' }, { id: 'zai-glm-4.7', ctx: '128K' }, { id: 'zai-glm-4.6', ctx: '128K' },
  ] },
  { id: 'vercel-ai-gateway', label: 'Vercel AI Gateway', envKey: 'AI_GATEWAY_API_KEY', models: [
    { id: 'anthropic/claude-opus-4.6', ctx: '200K' }, { id: 'openai/gpt-4o', ctx: '128K' }, { id: 'openai/gpt-4o-mini', ctx: '128K' },
  ] },
  { id: 'opencode', label: 'OpenCode Zen', envKey: 'OPENCODE_ZEN_API_KEY', models: [
    { id: 'claude-opus-4-6', ctx: '200K' }, { id: 'claude-sonnet-4-5', ctx: '200K' },
  ] },
  { id: 'moonshot', label: 'Moonshot (Kimi)', envKey: 'MOONSHOT_API_KEY', models: [
    { id: 'kimi-k2.5', ctx: '128K' }, { id: 'kimi-k2-0905-preview', ctx: '128K' }, { id: 'kimi-k2-turbo-preview', ctx: '128K' }, { id: 'kimi-k2-thinking', ctx: '256K' },
  ] },
  { id: 'synthetic', label: 'Synthetic', envKey: 'SYNTHETIC_API_KEY', models: [{ id: 'hf:MiniMaxAI/MiniMax-M2.1', ctx: '128K' }] },
  { id: 'minimax', label: 'MiniMax', envKey: 'MINIMAX_API_KEY', models: [{ id: 'MiniMax-M2.1', ctx: '128K' }] },
  { id: 'other', label: 'Other (custom)', envKey: null, models: [] },
];

app.get('/api/remote-providers', (req, res) => {
  res.json({ providers: REMOTE_PROVIDERS_LIST });
});


// GET /api/config — startup-config.json (for current local model display)
app.get('/api/config', (req, res) => {
  try {
    const raw = fs.readFileSync(CONFIG_PATH, 'utf8');
    const config = JSON.parse(raw);
    res.json(config);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Remote provider id -> env var for API key (OpenClaw convention)
const REMOTE_API_KEY_ENV = {
  xai: 'XAI_API_KEY',
  openai: 'OPENAI_API_KEY',
  anthropic: 'ANTHROPIC_API_KEY',
  openrouter: 'OPENROUTER_API_KEY',
  google: 'GEMINI_API_KEY',
  groq: 'GROQ_API_KEY',
  mistral: 'MISTRAL_API_KEY',
  cerebras: 'CEREBRAS_API_KEY',
  'vercel-ai-gateway': 'AI_GATEWAY_API_KEY',
  opencode: 'OPENCODE_ZEN_API_KEY',
  moonshot: 'MOONSHOT_API_KEY',
  synthetic: 'SYNTHETIC_API_KEY',
  minimax: 'MINIMAX_API_KEY',
};

// GET /api/check-remote-credentials?provider=xai or &apiKeyEnv=CUSTOM_KEY (for "other")
// Returns { envKey, set } so UI can prompt user to set env or enter key.
app.get('/api/check-remote-credentials', (req, res) => {
  const provider = req.query.provider;
  const apiKeyEnv = req.query.apiKeyEnv;
  const envKey = typeof apiKeyEnv === 'string' && apiKeyEnv.trim()
    ? apiKeyEnv.trim()
    : (provider && REMOTE_API_KEY_ENV[provider]);
  if (!envKey) {
    return res.json({ envKey: null, set: false });
  }
  const val = process.env[envKey];
  const set = !!(typeof val === 'string' && val.trim().length > 0);
  res.json({ envKey, set });
});

// PATCH /api/config — update mode (local|remote) and/or local/remote config
app.patch('/api/config', (req, res) => {
  try {
    const { mode, localModel, remoteModel, remote } = req.body;
    let config = {};
    if (fs.existsSync(CONFIG_PATH)) {
      config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
    }
    if (mode === 'local' || mode === 'remote') {
      config.mode = mode;
    }
    if (typeof localModel === 'string') {
      if (!config.local) config.local = {};
      config.local.model = localModel;
    }
    if (typeof remoteModel === 'string') {
      if (!config.remote) config.remote = {};
      config.remote.model = remoteModel;
    }
    if (remote && typeof remote === 'object') {
      if (!config.remote) config.remote = {};
      if (typeof remote.provider === 'string') config.remote.provider = remote.provider;
      if (typeof remote.model === 'string') config.remote.model = remote.model;
      if (typeof remote.baseUrl === 'string') config.remote.baseUrl = remote.baseUrl.trim() || undefined;
      if (remote.baseUrl === '') delete config.remote.baseUrl;
      if (typeof remote.apiKeyEnv === 'string') config.remote.apiKeyEnv = remote.apiKeyEnv.trim() || undefined;
      if (remote.apiKeyEnv === '') delete config.remote.apiKeyEnv;
    }
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2), 'utf8');
    const state = readState();
    if (config.mode) state.mode = config.mode;
    if (typeof localModel === 'string') state.model = localModel;
    if (config.remote?.model) state.model = config.remote.model;
    writeState(state);
    res.json(config);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/state — running PIDs and selected model
app.get('/api/state', (req, res) => {
  const state = readState();
  const running = {
    gateway: state.gatewayPid ? isPidRunning(state.gatewayPid) : false,
    dashboard: state.dashboardPid ? isPidRunning(state.dashboardPid) : false,
  };
  res.json({
    gatewayPid: state.gatewayPid,
    dashboardPid: state.dashboardPid,
    model: state.model,
    mode: state.mode,
    running,
  });
});

function isPidRunning(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

// POST /api/start — patch config, start gateway + dashboard (uses mode + model from body or config)
app.post('/api/start', (req, res) => {
  // activity log (best-effort)
  try {
    appendActivity({ memoryDir: MEMORY_DIR, line: `Start requested (mode=${req.body?.mode || 'auto'} model=${req.body?.model || 'auto'})` });
  } catch {}

  const state = readState();
  if (state.gatewayPid && isPidRunning(state.gatewayPid)) {
    return res.status(400).json({ error: 'Already running', running: true });
  }
  let config = {};
  try {
    if (fs.existsSync(CONFIG_PATH)) {
      config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
    }
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
  const mode = req.body.mode || config.mode || state.mode || 'local';
  const model = req.body.model || (mode === 'remote' ? config.remote?.model : config.local?.model) || state.model;
  if (!model) {
    return res.status(400).json({ error: mode === 'local' ? 'No model selected. Choose an Ollama model first.' : 'No remote model in config.' });
  }
  const patch = patchOpenClawModel(model);
  if (!patch.ok) {
    return res.status(400).json({ error: patch.message });
  }
  const env = {
    ...process.env,
    WORKSPACE_OPENCLAW_MODEL: model,
    ...(mode === 'local' ? { XAI_API_KEY: '' } : {}),
  };
  if (mode === 'remote') {
    const apiKeyEnv = config.remote?.apiKeyEnv || REMOTE_API_KEY_ENV[config.remote?.provider];
    if (typeof req.body.remoteApiKey === 'string' && req.body.remoteApiKey.trim()) {
      if (apiKeyEnv) env[apiKeyEnv] = req.body.remoteApiKey.trim();
    }
    if (config.remote?.baseUrl) {
      env.OPENAI_BASE_URL = config.remote.baseUrl;
      env.ANTHROPIC_BASE_URL = config.remote.baseUrl;
    }
  }
  const spawnOpts = (customEnv = {}) => ({
    cwd: workspaceRoot,
    env: { ...env, ...customEnv },
    stdio: ['ignore', 'pipe', 'pipe'],
    ...(isWindows ? { shell: true } : {}),
  });
  try {
    console.log('[start] Patching openclaw.json with model:', model);
    console.log('[start] Spawning gateway (port 18789)...');
    const gateway = spawn('openclaw', ['gateway', '--port', '18789'], spawnOpts());
    const gatewayPid = gateway.pid;
    if (!gatewayPid) {
      console.error('[start] Gateway spawn did not return a PID');
    } else {
      console.log('[start] Gateway started PID', gatewayPid);
    }
    gateway.on('error', (e) => console.error('[start] Gateway process error:', e.message));
    gateway.stderr.on('data', (d) => process.stderr.write('[gateway] ' + d));
    gateway.on('exit', (code, sig) => console.log('[start] Gateway exited code=%s signal=%s', code, sig));
    writeState({ gatewayPid, dashboardPid: null, model, mode });
    res.json({ ok: true, gatewayPid, dashboardPid: null, model, mode });

    setTimeout(() => {
      try {
        console.log('[start] Spawning dashboard...');
        const dashboard = spawn('openclaw', ['dashboard'], spawnOpts());
        const dashPid = dashboard.pid;
        if (!dashPid) {
          console.error('[start] Dashboard spawn did not return a PID');
        } else {
          console.log('[start] Dashboard started PID', dashPid);
        }
        dashboard.on('error', (e) => console.error('[start] Dashboard process error:', e.message));
        dashboard.stderr.on('data', (d) => process.stderr.write('[dashboard] ' + d));
        dashboard.on('exit', (code, sig) => console.log('[start] Dashboard exited code=%s signal=%s', code, sig));
        const state = readState();
        state.dashboardPid = dashPid;
        writeState(state);
      } catch (e) {
        console.error('[start] Failed to start dashboard:', e.message);
      }
    }, 4000);
  } catch (e) {
    console.error('[start] Spawn failed:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// POST /api/stop — kill gateway + dashboard
app.post('/api/stop', (req, res) => {
  // activity log (best-effort)
  try {
    appendActivity({ memoryDir: MEMORY_DIR, line: 'Stop requested' });
  } catch {}

  const state = readState();
  const killed = [];
  if (state.gatewayPid && isPidRunning(state.gatewayPid)) {
    try {
      process.kill(state.gatewayPid, 'SIGTERM');
      killed.push('gateway');
    } catch (e) {
      // already dead
    }
  }
  if (state.dashboardPid && isPidRunning(state.dashboardPid)) {
    try {
      process.kill(state.dashboardPid, 'SIGTERM');
      killed.push('dashboard');
    } catch (e) {}
  }
  writeState({ gatewayPid: null, dashboardPid: null, model: state.model });
  res.json({ ok: true, killed });
});

// GET /api/activity
app.get('/api/activity', (req, res) => {
  if (!fs.existsSync(MEMORY_DIR)) {
    return res.json([]);
  }
  const files = fs.readdirSync(MEMORY_DIR).filter((f) => f.endsWith('.md'));
  const activities = files.flatMap((file) => {
    const content = fs.readFileSync(path.join(MEMORY_DIR, file), 'utf8');
    return content.split('\n').filter((line) => line.trim()).map((line) => ({
      date: file.replace('.md', ''),
      description: line,
      file,
      raw: line,
    }));
  });
  res.json(activities);
});

// GET /api/dashboard/summary
app.get('/api/dashboard/summary', async (req, res) => {
  const result = await getDashboardSummary();
  if (!result.ok) return res.status(500).json(result);
  res.json(result);
});

// Notifications
app.get('/api/notifications', (req, res) => {
  const limit = Number(req.query.limit || 50);
  res.json(notifications.list({ limit }));
});

app.post('/api/notifications', (req, res) => {
  const { level, title, body, source, meta } = req.body || {};
  res.json(notifications.add({ level, title, body, source, meta }));
});

app.post('/api/notifications/dismiss', (req, res) => {
  const { id, beforeTs } = req.body || {};
  res.json(notifications.dismiss({ id, beforeTs }));
});

// GET /api/version — self vs GitHub main for update notice
app.get('/api/version', async (req, res) => {
  const now = Date.now();
  if (versionCheckCache.result != null && now - versionCheckCache.at < VERSION_CACHE_MS) {
    return res.json(versionCheckCache.result);
  }
  const latest = await fetchLatestVersion();
  const updateAvailable = latest != null && compareVersions(latest, CURRENT_VERSION) > 0;
  versionCheckCache = {
    result: { currentVersion: CURRENT_VERSION, latestVersion: latest || CURRENT_VERSION, updateAvailable },
    at: now,
  };
  res.json(versionCheckCache.result);
});

// GET /api/cron — include last run timestamp per job for UI
app.get('/api/cron', (req, res) => {
  const jobs = readJobs();
  const enriched = jobs.map((j) => {
    const jobId = j.jobId || j.id;
    if (!jobId) return { ...j, lastRunTs: null, lastRunStatus: null };
    const runs = readRuns(jobId, 1);
    const latest = runs[0];
    const lastRunTs = latest && (latest.ts != null || latest.timestamp != null)
      ? (latest.ts ?? latest.timestamp)
      : null;
    return {
      ...j,
      lastRunTs: lastRunTs != null ? Number(lastRunTs) : null,
      lastRunStatus: latest?.status ?? latest?.action ?? null,
    };
  });
  res.json({ jobs: enriched });
});

// POST /api/cron/:jobId/run
app.post('/api/cron/:jobId/run', async (req, res) => {
  const { jobId } = req.params;
  const result = await runNow(jobId);
  if (!result.ok) return res.status(500).json(result);

  // Best-effort notification + activity log
  try {
    notifications.add({
      level: 'info',
      title: 'Cron job run requested',
      body: `jobId=${jobId}`,
      source: 'cron',
      meta: { jobId },
    });
  } catch {}
  try {
    appendActivity({ memoryDir: MEMORY_DIR, line: `Cron run requested (jobId=${jobId})` });
  } catch {}

  res.json(result);
});

// GET /api/cron/:jobId/runs
app.get('/api/cron/:jobId/runs', (req, res) => {
  const { jobId } = req.params;
  const limit = Number(req.query.limit || 20);
  const runs = readRuns(jobId, limit);
  res.json({ ok: true, data: { runs } });
});

// GET /api/heartbeat
app.get('/api/heartbeat', async (req, res) => {
  const state = { lastHeartbeatAt: undefined, lastChecks: {} };
  try {
    if (fs.existsSync(HEARTBEAT_STATE_PATH)) {
      const data = JSON.parse(fs.readFileSync(HEARTBEAT_STATE_PATH, 'utf8'));
      state.lastHeartbeatAt = data.lastHeartbeatAt;
      state.lastChecks = data.lastChecks || {};
    }
  } catch {}
  let gateway = { ok: false };
  const base = GATEWAY_URL.replace(/\/$/, '');
  try {
    const healthRes = await fetch(`${base}/health`, { signal: AbortSignal.timeout(3000) });
    if (healthRes.ok) {
      const body = await healthRes.json();
      gateway = { ok: true, uptimeMs: body.uptimeMs, heartbeat: body.heartbeat };
    } else {
      const rootRes = await fetch(base, { signal: AbortSignal.timeout(3000) });
      gateway = { ok: true };
    }
  } catch {
    try {
      await fetch(base, { signal: AbortSignal.timeout(3000) });
      gateway = { ok: true };
    } catch {}
  }
  res.json({ gateway, state });
});

// SPA fallback — serve same HTML as / so preloads and no-cache apply
app.get('*', async (req, res) => {
  const models = await fetchOllamaModels().catch(() => []);
  let html = fs.readFileSync(indexPath, 'utf8');
  html = html.replace(PRELOAD_PLACEHOLDER, `window.__OLLAMA_MODELS__ = ${JSON.stringify(models)};`);
  html = html.replace(REMOTE_PROVIDERS_PLACEHOLDER, `window.__REMOTE_PROVIDERS__ = ${JSON.stringify(REMOTE_PROVIDERS_LIST)};`);
  html = html.replace(SERVED_FROM_PLACEHOLDER, `<!-- served from: ${indexPath} -->`);
  res.set({
    'Cache-Control': 'no-store, no-cache, must-revalidate',
    Pragma: 'no-cache',
    Expires: '0',
  });
  res.type('html').send(html);
});

app.listen(PORT, async () => {
  console.log(`Claw Mgr at http://127.0.0.1:${PORT}`);
  console.log(`Serving HTML from: ${path.resolve(indexPath)}`);
  const latest = await fetchLatestVersion();
  if (latest != null && compareVersions(latest, CURRENT_VERSION) > 0) {
    console.log(`[claw-mgr] Update available: ${CURRENT_VERSION} → ${latest} (https://github.com/Ascendism/claw-mgr)`);
  }
});
