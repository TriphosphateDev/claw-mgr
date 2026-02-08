const { runOpenClaw } = require('./openclawCli');

function findValue(raw, label) {
  const line = raw
    .split(/\r?\n/)
    .find((l) => l.toLowerCase().includes(label.toLowerCase()));
  if (!line) return null;
  const idx = line.indexOf('│');
  const parts = line.split('│').map((p) => p.trim()).filter(Boolean);
  if (parts.length >= 2) return parts[1];
  return idx >= 0 ? line.slice(idx + 1).trim() : line.trim();
}

function parseSecuritySummary(raw) {
  const m = raw.match(/Summary:\s*(\d+) critical\s*·\s*(\d+) warn\s*·\s*(\d+) info/i);
  if (!m) return null;
  return {
    critical: Number(m[1]),
    warn: Number(m[2]),
    info: Number(m[3]),
  };
}

function parseStatus(raw) {
  return {
    os: findValue(raw, 'OS'),
    channel: findValue(raw, 'Channel'),
    update: findValue(raw, 'Update'),
    gateway: findValue(raw, 'Gateway'),
    agents: findValue(raw, 'Agents'),
    sessions: findValue(raw, 'Sessions'),
    heartbeat: findValue(raw, 'Heartbeat'),
    lastHeartbeat: findValue(raw, 'Last heartbeat'),
    security: parseSecuritySummary(raw),
  };
}

async function getDashboardSummary() {
  const result = await runOpenClaw(['status', '--deep']);
  if (!result.ok) {
    return {
      ok: false,
      error: {
        code: 'OPENCLAW_STATUS_FAILED',
        message: 'Failed to fetch OpenClaw status',
        details: result.stderr || result.stdout,
      },
    };
  }

  return {
    ok: true,
    data: {
      parsed: parseStatus(result.stdout),
      raw: result.stdout,
      fetchedAt: Date.now(),
    },
  };
}

module.exports = {
  getDashboardSummary,
};
