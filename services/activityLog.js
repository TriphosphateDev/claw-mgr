const fs = require('fs');
const path = require('path');

const ACTIVITY_FILENAME = 'activity.log';

function appendActivity({ memoryDir, line }) {
  if (!memoryDir || line == null) return;
  const filePath = path.join(memoryDir, ACTIVITY_FILENAME);
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    const ts = new Date().toISOString();
    fs.appendFileSync(filePath, `${ts} ${line}\n`, 'utf8');
  } catch {}
}

module.exports = { appendActivity };
