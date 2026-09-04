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

function patchFrontend(html){
  if(html.includes('atc-v667-runtime-safety')) return html;
  const patch=String.raw`
<style id="atc-v667-runtime-safety-style">
#v661Journey.open .v661-step[data-step="intro"].active{display:block!important;visibility:visible!important;opacity:1!important;filter:none!important;transform:none!important;pointer-events:auto!important}
#v661Journey.open .v661-step[data-step="intro"].active #v665IntroScenes{display:block!important;visibility:visible!important;opacity:1!important}
#v661Journey.open .v661-step[data-step="intro"].active .v665-intro-scene.active{display:flex!important;visibility:visible!important;opacity:1!important;filter:none!important;transform:none!important}
</style>
<script id="atc-v667-runtime-safety">
(function(){
'use strict';
window.ATC_BUILD_VERSION='6.67';
const journey=document.getElementById('v661Journey');
const submit=document.getElementById('v661GateSubmit');
const input=document.getElementById('v661GateCode');
const err=document.getElementById('v661GateError');
if(!journey||!submit||!input)return;
function forceIntro(){
  try{
    document.getElementById('v662Transition')?.classList.remove('on');
    const steps=[...journey.querySelectorAll('.v661-step')];
    steps.forEach(el=>{
      const on=el.dataset.step==='intro';
      el.classList.toggle('active',on);
      el.classList.remove('v662-forward','v662-backward');
      if(on){el.classList.add('v662-forward');el.style.display='block';el.style.visibility='visible';el.style.opacity='1';el.style.filter='none';el.style.transform='none'}
      else{el.style.removeProperty('display');el.style.removeProperty('visibility');el.style.removeProperty('opacity');el.style.removeProperty('filter');el.style.removeProperty('transform')}
    });
    journey.classList.add('open');journey.setAttribute('aria-hidden','false');journey.scrollTop=0;
    const intro=journey.querySelector('[data-step="intro"]');
    const scenes=[...intro?.querySelectorAll('.v665-intro-scene')||[]];
    scenes.forEach((scene,i)=>{scene.classList.toggle('active',i===0);scene.classList.remove('leaving');if(i===0){scene.style.display='flex';scene.style.visibility='visible';scene.style.opacity='1';scene.style.filter='none';scene.style.transform='none'}else{scene.style.removeProperty('display');scene.style.removeProperty('visibility');scene.style.removeProperty('opacity');scene.style.removeProperty('filter');scene.style.removeProperty('transform')}});
    [...(intro?.querySelectorAll('#v665IntroDots i')||[])].forEach((d,i)=>d.classList.toggle('on',i===0));
    intro?.setAttribute('data-v665-played','1');
    requestAnimationFrame(()=>{if(journey.querySelector('.v661-step.active')?.dataset.step!=='intro')steps.forEach(el=>el.classList.toggle('active',el.dataset.step==='intro'))});
  }catch(e){console.error('[v6.67 gate->intro]',e)}
}
function verifyAfterOriginal(){
  setTimeout(()=>{
    const gate=journey.querySelector('.v661-step[data-step="gate"]');
    const hasError=String(err?.textContent||'').trim().length>0;
    const entered=String(input.value||'').trim().length>0;
    if(entered&&!hasError&&gate?.classList.contains('active'))forceIntro();
  },80);
}
submit.addEventListener('click',verifyAfterOriginal,true);
input.addEventListener('keydown',e=>{if(e.key==='Enter')verifyAfterOriginal()},true);
function mark(){const pill=document.querySelector('.version-pill');if(pill)pill.textContent='v6.67'}
if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',mark);else mark();
})();
</script>
<script id="atc-v667-version-final">window.ATC_BUILD_VERSION='6.67';</script>
`;
  const marker='</body>';
  if(!html.includes(marker)) throw new Error('Live frontend missing </body>');
  return html.replace(marker,patch+'\n'+marker);
}

async function getLiveFrontend(){
  const ctrl=new AbortController();
  const timer=setTimeout(()=>ctrl.abort(),15000);
  try{
    const r=await fetch('https://atcfnb.com/',{signal:ctrl.signal,headers:{'cache-control':'no-cache','user-agent':'ATC-FNB-bootstrap/6.67'}});
    if(!r.ok) throw new Error('live frontend HTTP '+r.status);
    const html=await r.text();
    if(!html.includes('ATC-F&B')) throw new Error('live frontend validation failed');
    return html;
  }finally{clearTimeout(timer)}
}

(async()=>{
  restore('server-','server.js');
  const live=await getLiveFrontend();
  fs.writeFileSync(path.join(base,'index.html'),patchFrontend(live));
  require('./server.js');
})().catch(err=>{console.error('[bootstrap]',err);process.exit(1)});
