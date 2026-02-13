const { spawn, spawnSync } = require('child_process');
const path = require('path');

const isWindows = process.platform === 'win32';

let _resolvedOpenClawEntrypoint = null;

function resolveOpenClawEntrypoint() {
  if (_resolvedOpenClawEntrypoint) return _resolvedOpenClawEntrypoint;

  // Prefer explicit override.
  if (process.env.OPENCLAW_ENTRYPOINT) {
    _resolvedOpenClawEntrypoint = { kind: 'direct', cmd: process.env.OPENCLAW_ENTRYPOINT, argsPrefix: [] };
    return _resolvedOpenClawEntrypoint;
  }

  if (!isWindows) {
    _resolvedOpenClawEntrypoint = { kind: 'bin', cmd: 'openclaw', argsPrefix: [] };
    return _resolvedOpenClawEntrypoint;
  }

  // Windows: avoid openclaw.ps1 (often blocked by execution policy) and avoid cmd.exe JSON mangling.
  // Strategy: locate openclaw.cmd on PATH, then call its underlying JS entrypoint with node.
  const w = spawnSync('cmd.exe', ['/d', '/s', '/c', 'where openclaw.cmd'], { encoding: 'utf8' });
  const cmdPath = String(w.stdout || '').split(/\r?\n/).map((s) => s.trim()).filter(Boolean)[0] || null;
  if (cmdPath) {
    const dp0 = path.dirname(cmdPath);
    const mjs = path.join(dp0, 'node_modules', 'openclaw', 'openclaw.mjs');
    _resolvedOpenClawEntrypoint = { kind: 'node+mjs', cmd: 'node', argsPrefix: [mjs] };
    return _resolvedOpenClawEntrypoint;
  }

  // Fallback: try openclaw (may hit ps1 restrictions, but better than nothing).
  _resolvedOpenClawEntrypoint = { kind: 'bin', cmd: 'openclaw', argsPrefix: [] };
  return _resolvedOpenClawEntrypoint;
}

function runOpenClaw(args = [], options = {}) {
  return new Promise((resolve) => {
    const ep = resolveOpenClawEntrypoint();
    const child = spawn(ep.cmd, [...(ep.argsPrefix || []), ...args], {
      shell: false,
      windowsHide: true,
      ...options,
    });

    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (d) => (stdout += d.toString()));
    child.stderr.on('data', (d) => (stderr += d.toString()));

    child.on('error', (error) => {
      resolve({ ok: false, code: -1, stdout, stderr: stderr || error.message });
    });

    child.on('close', (code) => {
      resolve({ ok: code === 0, code, stdout, stderr });
    });
  });
}

module.exports = {
  runOpenClaw,
};
