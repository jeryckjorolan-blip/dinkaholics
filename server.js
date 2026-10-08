const fs = require('fs');
const path = require('path');
eval(
  fs.readFileSync(path.join(__dirname, 'app-part1.js'), 'utf8') +
  fs.readFileSync(path.join(__dirname, 'app-part2a.js'), 'utf8') +
  fs.readFileSync(path.join(__dirname, 'app-part2b.js'), 'utf8')
);
