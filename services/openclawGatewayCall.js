const { runOpenClaw } = require('./openclawCli');

function safeJsonParse(s) {
  try { return JSON.parse(s); } catch { return null; }
}

async function gatewayCall(method, paramsObj, opts = {}) {
  const timeoutMs = Number(opts.timeoutMs || 15000);
  const params = paramsObj && typeof paramsObj === 'object' ? JSON.stringify(paramsObj) : '{}';

  // Use the gateway CLI so we don't have to re-implement the WebSocket protocol in ClawMGR.
  // Note: --url/--token can be plumbed later if needed.
  const args = ['gateway', 'call', '--json', '--timeout', String(timeoutMs), method, '--params', params];
  const r = await runOpenClaw(args);
  if (!r.ok) return { ok: false, error: (r.stderr || r.stdout || '').trim() || `gateway call failed (code=${r.code})` };

  const data = safeJsonParse(r.stdout);
  if (!data) return { ok: false, error: 'Failed to parse gateway call JSON output' };
  return { ok: true, result: data };
}

module.exports = {
  gatewayCall,
};
