const { spawn } = require('child_process');

const isWindows = process.platform === 'win32';

function runOpenClaw(args = [], options = {}) {
  return new Promise((resolve) => {
    const child = spawn('openclaw', args, {
      shell: isWindows,
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
