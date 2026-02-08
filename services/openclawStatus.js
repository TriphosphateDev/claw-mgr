const { runOpenClaw } = require('./openclawCli');

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
      raw: result.stdout,
      fetchedAt: Date.now(),
    },
  };
}

module.exports = {
  getDashboardSummary,
};
