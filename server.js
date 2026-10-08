const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const n = 8;
const parts = [];
for (let i = 0; i < n; i++) {
  parts.push(fs.readFileSync(path.join(__dirname, 'gz' + i + '.txt'), 'utf8').trim());
}
eval(zlib.gunzipSync(Buffer.from(parts.join(''), 'base64')).toString('utf8'));
