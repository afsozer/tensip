import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import { MockUyap, opakToken } from '../dist/test/mock-uyap/sunucu.js';
import { makeHtml } from '../dist/test/yardimci.js';
import { RegistryDepo } from '../dist/src/store/registry.js';
import { ManifestDepo } from '../dist/src/store/manifest.js';
mkdirSync(resolve('logs'),{recursive:true}); // logs/ depoda yok (.gitignore); temiz klonda da çalışsın
const root=mkdtempSync(resolve('logs/p05-restart-')), archive=join(root,'archive');
const wait=ms=>new Promise(r=>setTimeout(r,ms));
const davalar=[1,2,3].map(n=>({dosyaId:opakToken(`p05-${n}`),birimAdi:'P05 Test Mahkemesi',birimId:'p05',esasNo:`2026/${n}`,dosyaTur:'Hukuk Dava Dosyası',dosyaDurum:'Açık',yargiTuru:'0',evraklar:Array.from({length:4},(_,i)=>({evrakId:opakToken(`doc-${n}-${i}`),tur:'Dilekçe',gonderen:'Test',tip:'GLN',tarih:'11/09/2026',birimEvrakNo:String(i+1),durum:'yuklu',contentTipi:'text/html',icerik:makeHtml(`<p>Test ${n}-${i}</p>`)}))}));
const keys=davalar.map((c,i)=>{
 const key=`${c.birimAdi}\u0000${c.esasNo}`,klonYolu=join(archive,String(i));
 new RegistryDepo(join(root,'davalarim.json')).koy({caseKey:key,portal:'avukat',kaynak:['portal'],dosyaNo:c.esasNo,birimAdi:c.birimAdi,birimId:'p05',group:'Hukuk',kod:'H',yargiTuru:'0',isIcra:false,isCbs:false,kapsam:'hepsi',portalGoruldu:'',klonYolu});
 new ManifestDepo(join(klonYolu,'uyap-project.json')).yaz({dosyaId:c.dosyaId,mahkeme:c.birimAdi,birimId:'p05',esasNo:c.esasNo,isIcra:false,clonedAt:'',evraklar:[]});
 return key;
});
const mock=new MockUyap({birimler:[{birimId:'p05',birimAdi:'P05 Test Mahkemesi',yargiTuru:'0'}],davalar});
const children=[];let control;
async function start(){
 const p=spawn(process.execPath,['dist/src/cli/tensipd.js','baslat',`--ayar=${root}`,`--kok=${archive}`,`--portal=${mock.adres()}`,'--web=false','--istek-aralik=90'],{stdio:'ignore'});children.push(p);
 for(let i=0;i<100;i++){try{const k=JSON.parse(readFileSync(join(root,'control.json'),'utf8'));if(k.pid===p.pid){control=k;await rpc('kimlik',{});return p;}}catch{}await wait(50);}throw Error('Motor hazır olmadı');
}
async function rpc(ad,body){const res=await fetch(`http://127.0.0.1:${control.port}/rpc/${ad}`,{method:'POST',headers:{authorization:`Bearer ${control.token}`,'content-type':'application/json'},body:JSON.stringify(body),signal:AbortSignal.timeout(5000)});const g=await res.json();if(!g.ok)throw Error(JSON.stringify(g.error));return g.data;}
async function until(predicate){for(let i=0;i<400;i++){const h=await rpc('isler',{});if(predicate(h))return h;await wait(25);}throw Error('Kuyruk beklenen duruma gelmedi');}
async function exit(p,signal){if(p.exitCode!==null||p.signalCode!==null)return;if(signal)p.kill(signal);for(let i=0;i<100;i++){if(p.exitCode!==null||p.signalCode!==null)return;await wait(30);}throw Error('Motor kapanmadı');}
const hash=p=>createHash('sha256').update(readFileSync(p)).digest('hex');
try{
 await mock.baslat();const first=await start();await rpc('giris',{cerez:'JSESSIONID=first'});
 const batch=await rpc('toplu-esitle',{caseKeys:keys});
 await until(h=>h.isler.some(j=>j.caseKey===keys[1]&&j.ilerleme.biten>=1&&j.durum==='calisiyor'));
 await exit(first,'SIGKILL');
 const sources=readdirSync(archive,{recursive:true}).filter(p=>p.includes('_kaynak/')&&p.endsWith('.html')).map(p=>join(archive,p));
 assert.ok(sources.length>=5&&sources.length<8);const saved=new Map(sources.map(p=>[p,hash(p)]));
 const count=JSON.parse(readFileSync(join(root,'fren.json'),'utf8')).gunlukSayac;assert.equal(count,2);
 const before=mock.istekler.length;const second=await start();await wait(100);assert.equal(mock.istekler.length,before);
 assert.equal((await rpc('durum',{yerel:true})).fren.gunlukSayac,count);
 const state=await rpc('isler',{});assert.equal(state.topluIsler[0].durum,'kesildi');assert.equal(state.isler[0].durum,'hazir');assert.ok(state.isler[1].sonuc.yeniEvrak>=1,'Kısmi indirme sayısı kayboldu');
 await rpc('giris',{cerez:'JSESSIONID=second'});const downloadBefore=mock.istekler.filter(r=>r.yol.includes('view_document')).length;
 await rpc('toplu-devam',{id:batch.id});
 const done=await until(h=>h.topluIsler[0].durum==='hazir');assert.deepEqual(done.topluIsler[0].dosyalar.map(d=>d.denemeler.length),[1,2,1]);
 const downloads=mock.istekler.filter(r=>r.yol.includes('view_document')).length-downloadBefore;assert.equal(downloads,12-saved.size);for(const [p,h] of saved)assert.equal(hash(p),h);
 const cancel=await rpc('toplu-esitle',{caseKeys:keys});await rpc('toplu-iptal',{id:cancel.id});await exit(second,'SIGKILL');
 const third=await start();assert.equal((await rpc('isler',{})).topluIsler[1].durum,'iptal');
 await rpc('durdur',{instanceId:control.instanceId});await exit(third);assert.equal(third.exitCode,0);
 console.log(JSON.stringify({counterSurvivesKill:true,queueSurvivesKill:true,completedCaseSkipped:true,preservedSources:saved.size,remainingDownloads:downloads,cancellationSurvivesKill:true}));
}finally{for(const p of children){try{await exit(p,'SIGKILL');}catch{}}await mock.durdur();rmSync(root,{recursive:true,force:true});}
