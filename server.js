const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const parts = [];
for (let i = 0; i < 4; i++) {
  parts.push(fs.readFileSync(path.join(__dirname, 'gz' + i + '.txt'), 'utf8').trim());
}
const code = zlib.gunzipSync(Buffer.from(parts.join(''), 'base64')).toString('utf8');
eval(code);
