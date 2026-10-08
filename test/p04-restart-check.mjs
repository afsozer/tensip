import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import { MockUyap, opakToken } from '../dist/test/mock-uyap/sunucu.js';
import { makeUdf } from '../dist/test/yardimci.js';
mkdirSync(resolve('logs'),{recursive:true}); // logs/ depoda yok (.gitignore); temiz klonda da çalışsın
const root=mkdtempSync(resolve('logs/p04-restart-')), archive=join(root,'archive');
const wait=ms=>new Promise(r=>setTimeout(r,ms));
const dava={dosyaId:opakToken('initial-case'),birimAdi:'P04 Test Mahkemesi',birimId:'p04',esasNo:'2026/4',dosyaTur:'Hukuk Dava Dosyası',dosyaDurum:'Açık',yargiTuru:'0',evraklar:Array.from({length:24},(_,i)=>({evrakId:opakToken(`initial-${i}`),tur:'Dilekçe',gonderen:'Av. Test',tip:'GLN',tarih:'09/09/2026',birimEvrakNo:String(i+1),durum:'yuklu',contentTipi:'application/octet-stream',icerik:makeUdf([`Test belge ${i}`])}))};
const mock=new MockUyap({birimler:[{birimId:'p04',birimAdi:dava.birimAdi,yargiTuru:'0'}],davalar:[dava]});
const children=[]; let control;
async function start(){
 const p=spawn(process.execPath,['dist/src/cli/tensipd.js','baslat',`--ayar=${root}`,`--kok=${archive}`,`--portal=${mock.adres()}`,'--web=false','--istek-aralik=90'],{stdio:'ignore'});children.push(p);
 for(let i=0;i<100;i++){try{const k=JSON.parse(readFileSync(join(root,'control.json'),'utf8'));if(k.pid===p.pid){control=k;await rpc('kimlik',{});return p;}}catch{}await wait(50);}throw Error('Motor hazır olmadı');
}
async function rpc(ad,body){const res=await fetch(`http://127.0.0.1:${control.port}/rpc/${ad}`,{method:'POST',headers:{authorization:`Bearer ${control.token}`,'content-type':'application/json'},body:JSON.stringify(body),signal:AbortSignal.timeout(5000)});const g=await res.json();if(!g.ok)throw Error(JSON.stringify(g.error));return g.data;}
async function jobUntil(id,predicate){for(let i=0;i<250;i++){const j=await rpc('is',{isId:id});if(predicate(j))return j;await wait(40);}throw Error('İş beklenen duruma gelmedi');}
async function exit(p,signal){if(p.exitCode!==null||p.signalCode!==null)return;if(signal)p.kill(signal);for(let i=0;i<100;i++){if(p.exitCode!==null||p.signalCode!==null)return;await wait(30);}throw Error('Motor kapanmadı');}
const hash=path=>createHash('sha256').update(readFileSync(path)).digest('hex');
try{
 await mock.baslat();const first=await start();await rpc('giris',{cerez:'JSESSIONID=first'});
 const original=await rpc('klonla',{birim:dava.birimAdi,esas:dava.esasNo,kapsam:'hepsi',avukat:'Test Avukat',grup:'Test Grubu',kod:'T04'});
 await jobUntil(original.isId,j=>j.ilerleme.biten>=3&&j.durum==='calisiyor');await exit(first,'SIGKILL');
 const paths=readdirSync(archive,{recursive:true}).filter(p=>p.endsWith('.udf')).map(p=>join(archive,p));assert.ok(paths.length>=3&&paths.length<24);const saved=new Map(paths.map(p=>[p,hash(p)]));
 dava.dosyaId=opakToken('fresh-case');dava.evraklar.forEach((e,i)=>e.evrakId=opakToken(`fresh-${i}`));
 const before=mock.istekler.length;const second=await start();await wait(300);assert.equal(mock.istekler.length,before,'Restart kendiliğinden portal trafiği yaptı');
 const history=await rpc('isler',{});assert.ok(history.isler.some(j=>j.isId===original.isId&&j.durum==='kesildi'));
 await rpc('giris',{cerez:'JSESSIONID=second'});const downloadBefore=mock.istekler.filter(r=>r.yol.includes('view_document')).length;
 const resumed=await rpc('devam',{isId:original.isId});const done=await jobUntil(resumed.isId,j=>['hazir','eksikli','hata','iptal'].includes(j.durum));assert.equal(done.durum,'hazir',JSON.stringify(done.hata));
 const downloads=mock.istekler.filter(r=>r.yol.includes('view_document')).length-downloadBefore;assert.equal(downloads,24-saved.size,'Önceden inen kaynak tekrar indirildi');for(const [p,h] of saved)assert.equal(hash(p),h);
 const cancelJob=await rpc('klonla',{birim:dava.birimAdi,esas:dava.esasNo,kapsam:'hepsi',avukat:'Test Avukat',grup:'Test Grubu',kod:'T04'});
 const cancellation=await rpc('iptal',{isId:cancelJob.isId});assert.equal(cancellation.ok,true);await exit(second,'SIGKILL');
 const third=await start();assert.equal((await rpc('is',{isId:cancelJob.isId})).durum,'iptal');
 await rpc('durdur',{instanceId:control.instanceId});await exit(third);assert.equal(third.exitCode,0);
 console.log(JSON.stringify({restartHistory:true,noAutomaticPortalTraffic:true,freshTokensResume:true,preservedSources:saved.size,remainingDownloads:downloads,finalState:done.durum,activeCancellationSurvivesRestart:true,naturalExit:third.exitCode}));
}finally{for(const p of children){try{await exit(p,'SIGKILL');}catch{}}await mock.durdur();rmSync(root,{recursive:true,force:true});}
