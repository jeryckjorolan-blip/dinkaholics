const fs = require('fs');
const path = require('path');
eval(
  fs.readFileSync(path.join(__dirname, 'app-p1.js'), 'utf8') +
  fs.readFileSync(path.join(__dirname, 'app-p2.js'), 'utf8') +
  fs.readFileSync(path.join(__dirname, 'app-p3.js'), 'utf8')
);
