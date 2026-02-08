const express = require('express');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawn } = require('child_process');

const app = express();
const PORT = Number(process.env.PORT) || 8011;
const isWindows = process.platform === 'win32';
const workspaceRoot = path.join(__dirname, '..');
const CONFIG_PATH = path.join(workspaceRoot, 'startup-config.json');
const OPENCLAW_CONFIG_PATH = path.join(os.homedir(), '.openclaw', 'openclaw.json');
const STATE_PATH = path.join(__dirname, '.claw-mgr-state.json');
const MEMORY_DIR = path.join(workspaceRoot, 'memory');
const HEARTBEAT_STATE_PATH = path.join(MEMORY_DIR, 'heartbeat-state.json');
const CRON_JOBS_PATH = path.join(os.homedir(), '.openclaw', 'cron', 'jobs.json');
const GATEWAY_URL = process.env.OPENCLAW_GATEWAY_URL || 'http://127.0.0.1:18789';

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

// GET /api/cron
app.get('/api/cron', (req, res) => {
  try {
    if (!fs.existsSync(CRON_JOBS_PATH)) {
      return res.json({ jobs: [] });
    }
    const raw = fs.readFileSync(CRON_JOBS_PATH, 'utf8');
    const data = JSON.parse(raw);
    const jobs = Array.isArray(data) ? data : data?.jobs || [];
    const list = (Array.isArray(jobs) ? jobs : []).map((j) => ({
      jobId: j.jobId ?? j.id,
      name: j.name ?? '(unnamed)',
      enabled: j.enabled !== false,
      schedule: j.schedule,
      payload: j.payload,
      sessionTarget: j.sessionTarget,
      ...j,
    }));
    res.json({ jobs: list });
  } catch (e) {
    res.status(500).json({ error: e.message, jobs: [] });
  }
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

app.listen(PORT, () => {
  console.log(`Claw Mgr at http://127.0.0.1:${PORT}`);
  console.log(`Serving HTML from: ${path.resolve(indexPath)}`);
});
