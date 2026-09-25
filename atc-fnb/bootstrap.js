'use strict';
const fs=require('fs');
const path=require('path');
const zlib=require('zlib');

const base=__dirname;
const payload=path.join(base,'payload');

function readPayload(prefix){
  const files=fs.readdirSync(payload).filter(x=>x.startsWith(prefix)&&x.endsWith('.b64')).sort();
  if(!files.length) throw new Error('Missing payload: '+prefix);
  const b64=files.map(f=>fs.readFileSync(path.join(payload,f),'utf8').trim()).join('');
  return zlib.gunzipSync(Buffer.from(b64,'base64'));
}
function restore(prefix,out){
  fs.writeFileSync(path.join(base,out),readPayload(prefix));
}
function restoreTar(prefix){
  const raw=readPayload(prefix);
  for(let offset=0;offset+512<=raw.length;){
    const name=raw.subarray(offset,offset+100).toString('utf8').replace(/\0.*$/,'').trim();
    if(!name)break;
    const sizeText=raw.subarray(offset+124,offset+136).toString('ascii').replace(/\0.*$/,'').trim();
    const size=parseInt(sizeText,8)||0;
    const start=offset+512,end=start+size;
    const target=path.resolve(base,name);
    if(target!==base&&!target.startsWith(base+path.sep))throw new Error('Invalid payload path: '+name);
    if(name.endsWith('/')){
      fs.mkdirSync(target,{recursive:true});
    }else{
      fs.mkdirSync(path.dirname(target),{recursive:true});
      fs.writeFileSync(target,raw.subarray(start,end));
    }
    offset=start+Math.ceil(size/512)*512;
  }
}

restoreTar('app-');
restore('frontend-','index.html');
restore('server-','server.js');
// Deploy v7.262.0 - production operations, lazy heavy assets, compressed cache-safe delivery
require('./server.js');
