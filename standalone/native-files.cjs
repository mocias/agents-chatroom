'use strict';
const fs = require('node:fs');
const crypto = require('node:crypto');
// Compare again immediately before replacing; keep a recoverable original.
function replaceFile(file, original, content) {
  if (original === content) return false;
  const read = () => fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null;
  if (read() !== original) throw Error('登记文件已变化，将在下次重试');
  const tmp = file + '.agent-room-' + crypto.randomUUID() + '.tmp';
  try {
    fs.writeFileSync(tmp, content, { flag: 'wx' });
    if (read() !== original) throw Error('登记文件已变化，将在下次重试');
    if (original !== null) fs.copyFileSync(file, file + '.before-agent-room-' + Date.now() + '-' + crypto.randomUUID());
    fs.renameSync(tmp, file);
  } finally { if (fs.existsSync(tmp)) fs.unlinkSync(tmp); }
  return true;
}
module.exports = { replaceFile };
