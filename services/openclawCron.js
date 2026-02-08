const fs = require('fs');
const path = require('path');
const os = require('os');
const { runOpenClaw } = require('./openclawCli');

const CRON_ROOT = path.join(os.homedir(), '.openclaw', 'cron');
const CRON_JOBS_PATH = path.join(CRON_ROOT, 'jobs.json');
const CRON_RUNS_DIR = path.join(CRON_ROOT, 'runs');

function readJobs() {
  try {
    if (!fs.existsSync(CRON_JOBS_PATH)) return [];
    const raw = fs.readFileSync(CRON_JOBS_PATH, 'utf8');
    const data = JSON.parse(raw);
    const jobs = Array.isArray(data) ? data : data?.jobs || [];
    return jobs.map((j) => ({
      ...j,
      jobId: j.jobId ?? j.id,
      name: j.name ?? '(unnamed)',
      enabled: j.enabled !== false,
    }));
  } catch {
    return [];
  }
}

function readRuns(jobId, limit = 50) {
  try {
    const filePath = path.join(CRON_RUNS_DIR, `${jobId}.jsonl`);
    if (!fs.existsSync(filePath)) return [];
    const lines = fs
      .readFileSync(filePath, 'utf8')
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean);

    const parsed = lines
      .map((line) => {
        try {
          return JSON.parse(line);
        } catch {
          return null;
        }
      })
      .filter(Boolean)
      .reverse()
      .slice(0, Math.max(1, Math.min(200, Number(limit) || 50)));

    return parsed;
  } catch {
    return [];
  }
}

async function runNow(jobId) {
  const result = await runOpenClaw(['cron', 'run', jobId]);
  return {
    ok: result.ok,
    data: {
      stdout: result.stdout,
      stderr: result.stderr,
      code: result.code,
    },
  };
}

module.exports = {
  readJobs,
  readRuns,
  runNow,
};
