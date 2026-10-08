const fs = require('fs');
const path = require('path');
eval(
  fs.readFileSync(path.join(__dirname, 'ap0.js'), 'utf8') +
  fs.readFileSync(path.join(__dirname, 'ap1.js'), 'utf8') +
  fs.readFileSync(path.join(__dirname, 'ap2.js'), 'utf8') +
  fs.readFileSync(path.join(__dirname, 'ap3.js'), 'utf8')
);
