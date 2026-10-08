const fs=require('fs');const path=require('path');
eval(fs.readFileSync(path.join(__dirname,'m0.js'),'utf8')+fs.readFileSync(path.join(__dirname,'m1.js'),'utf8')+fs.readFileSync(path.join(__dirname,'m2.js'),'utf8')+fs.readFileSync(path.join(__dirname,'m3.js'),'utf8'));
