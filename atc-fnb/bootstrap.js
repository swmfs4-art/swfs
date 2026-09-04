'use strict';
const fs=require('fs');
const path=require('path');
const zlib=require('zlib');
const base=__dirname;
const payload=path.join(base,'payload');
function restore(prefix,out){
  const files=fs.readdirSync(payload).filter(x=>x.startsWith(prefix)&&x.endsWith('.b64')).sort();
  if(!files.length) throw new Error('Missing payload: '+prefix);
  const b64=files.map(f=>fs.readFileSync(path.join(payload,f),'utf8').trim()).join('');
  const raw=zlib.gunzipSync(Buffer.from(b64,'base64'));
  fs.writeFileSync(path.join(base,out),raw);
}
restore('frontend-','index.html');
restore('server-','server.js');
require('./server.js');
