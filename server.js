const fs = require('fs');
const path = require('path');
let code = '';
for (let i = 0; i < 5; i++) {
  code += fs.readFileSync(path.join(__dirname, 'src_part' + i + '.txt'), 'utf8');
}
eval(code);
