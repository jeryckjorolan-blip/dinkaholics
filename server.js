const fs = require('fs');
const path = require('path');
let code = '';
for (let i = 0; i < 10; i++) {
  code += fs.readFileSync(path.join(__dirname, 'sp' + i + '.txt'), 'utf8');
}
eval(code);
