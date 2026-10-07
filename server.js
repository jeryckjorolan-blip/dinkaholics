const fs = require('fs');
const path = require('path');
let code = '';
for (let i = 0; i < 13; i++) {
  code += fs.readFileSync(path.join(__dirname, 's' + i + '.txt'), 'utf8');
}
eval(code);
