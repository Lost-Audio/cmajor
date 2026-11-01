import fs from'node:fs';import path from'node:path';import vm from'node:vm';import assert from'node:assert/strict';import{execFileSync}from'node:child_process';import{fileURLToPath}from'node:url';
import{decodeBlob,modelStats}from'./morph-core.js';import{analyze,decodeWav,encodeViscoBlob}from'./visco-analysis.js';
import worker from'./worker.js';
globalThis.HTMLElement=class{};
const {importWav}=await import('./view/index.js');
const root=path.dirname(fileURLToPath(import.meta.url)),fixture=path.join(root,'fixtures'),artifacts=path.join(root,'test-artifacts');
fs.mkdirSync(artifacts,{recursive:true});
const reference=JSON.parse(fs.readFileSync(path.join(fixture,'reference.json'))),cache=new Map(),imports=[];
for(const r of reference.imports){
 const buffer=fs.readFileSync(path.join(fixture,r.wav)),decoded=decodeWav(buffer),loaded=Buffer.from(r.loaded,'base64');
 assert.equal(decoded.sampleRate,r.sampleRate);assert.equal(decoded.samples.byteLength,loaded.length);
 for(let i=0;i<decoded.samples.length;i++)assert.equal(decoded.samples[i],loaded.readFloatLE(4*i),`${r.id}: decoded sample ${i}`);
 const start=performance.now(),m=analyze(decoded.samples,decoded.sampleRate),ms=performance.now()-start;
 for(const key of ['time','frequency'])for(let row=0;row<m[key].length;row++)for(let q=0;q<m[key][row].length;q++)assert.equal(m[key][row][q],Math.fround(r.model[key][row][q]),`${r.id}: ${key} ${row}/${q}`);
 assert.deepEqual(Buffer.from(encodeViscoBlob(m)),Buffer.from(r.model.blob,'base64'),r.id+': stored model');
 cache.set(r.wav,modelStats(m));imports.push({name:r.id,coordinatesExact:true,blobExact:true,analysisMs:+ms.toFixed(1)});
}
// Native UI import saves and reloads a blob before playback. Keep this separate from raw analysis.
const uiCache=new Map(),uiImports=[];
for(const r of reference.uiImports){
 const buffer=fs.readFileSync(path.join(fixture,r.wav)),m=modelStats(importWav(buffer,r.wav));
 const decoded=decodeWav(buffer),raw=analyze(decoded.samples,decoded.sampleRate);
 assert.deepEqual(Buffer.from(encodeViscoBlob(raw)),fs.readFileSync(path.join(fixture,r.blob)),r.wav+': UI saved model');
 for(const key of ['time','frequency'])for(let row=0;row<m[key].length;row++)for(let q=0;q<m[key][row].length;q++)assert.equal(m[key][row][q],Math.fround(r.model[key][row][q]),`${r.wav}: UI ${key} ${row}/${q}`);
 uiCache.set(r.wav,m);uiImports.push({name:r.wav,coordinatesExact:true,blobExact:true});
}
const generated=path.join(artifacts,'engine.js');
execFileSync('cmaj',['generate','--target=javascript','--output='+generated,'MorphFieldExact.cmajorpatch'],{cwd:root,stdio:'pipe'});
const Engine=vm.runInNewContext(fs.readFileSync(generated,'utf8')+'\nMorphFieldExact;',{WebAssembly,TextDecoder,TextEncoder,console,atob});
const load=name=>{if(!cache.has(name))cache.set(name,modelStats(decodeBlob(fs.readFileSync(path.join(fixture,name)))));return cache.get(name);};
const audio=[];
for(const c of reference.cases){
 const e=new Engine();await e.initialise(reference.seed,c.rate);
 if(c.importMode==='stored'){
  let listener;
  worker({addStoredStateValueListener(fn){listener=fn;},requestStoredStateValue(key){listener({key,value:uiCache.get(key.endsWith('A')?c.a:c.b)});},sendEventOrValue(id,value){e['sendInputEvent_'+id](value);}});
  await Promise.resolve();await Promise.resolve();
 }else for(const [slot,name]of[c.a,c.b].entries()){
  const m=load(name);
  for(let i=0;i<7;i++)e.sendInputEvent_modelCurve({slot,kind:0,index:i,positions:[...m.time[i],...Array(8).fill(0)]});
  for(let i=0;i<6;i++)e.sendInputEvent_modelCurve({slot,kind:1,index:i,positions:m.frequency[i]});
  e.sendInputEvent_modelInfo({slot,norm:m.norm,duration:m.duration,tail:m.tail});
 }
 e.sendInputEvent_morph(c.mix);e.sendInputEvent_level(0);
 e.sendInputEvent_limiter(Boolean(c.limiter));e.sendInputEvent_limiterGain(c.limiterGain??0);e.sendInputEvent_limiterSpeed(c.limiterSpeed??50);
 if(c.preRoll){for(let n=c.preRoll;n>0;n-=128)e.advance(Math.min(128,n));}
 e.sendInputEvent_audition(c.velocity??1);
 const count=Math.round(c.rate*c.seconds),left=new Float32Array(count),right=new Float32Array(count);
 for(let pos=0;pos<count;){
  if(pos===c.retrigger)e.sendInputEvent_audition(c.velocity??1);if(pos===c.morphAt)e.sendInputEvent_morph(c.nextMix);
  let n=Math.min(128,count-pos);for(const event of[c.retrigger,c.morphAt])if(event>pos)n=Math.min(n,event-pos);
  e.advance(n);e.getOutputFrames_out([left.subarray(pos,pos+n),right.subarray(pos,pos+n)],n,0);pos+=n;
 }
 const expected=fs.readFileSync(path.join(fixture,c.audio));assert.equal(expected.length,count*4);
 let max=0,error=0,power=0,attackError=0,attackPower=0;
 for(let i=0;i<count;i++){
  assert.ok(Number.isFinite(left[i]),c.id+': finite output');assert.equal(left[i],right[i],c.id+': neutral stereo');
  const ref=expected.readFloatLE(i*4),d=left[i]-ref;max=Math.max(max,Math.abs(d));error+=d*d;power+=ref*ref;
  if(i<c.rate*.05){attackError+=d*d;attackPower+=ref*ref;}
 }
 const snr=10*Math.log10(power/error),attackSnr=10*Math.log10(attackPower/attackError);
 assert.ok(max<0.00001,`${c.id}: sample error ${max}`);assert.ok(snr>115,`${c.id}: audio difference ${snr} dB`);assert.ok(attackSnr>115,`${c.id}: attack difference ${attackSnr} dB`);
 audio.push({name:c.id,importMode:c.importMode??(c.a.endsWith('.wav')?'raw':'blob'),rate:c.rate,seconds:c.seconds,maxSampleError:max,differenceDb:-snr,attackDifferenceDb:-attackSnr});
 if(c.id==='audio-wav-kick')fs.writeFileSync(path.join(artifacts,'kick-candidate.f32'),Buffer.from(left.buffer));
 if(c.limiter)fs.writeFileSync(path.join(artifacts,c.id+'-candidate.f32'),Buffer.from(left.buffer));
}
const result={passed:true,referenceVersion:reference.version,imports,uiImports,audio};fs.writeFileSync(path.join(root,'test-results.json'),JSON.stringify(result,null,2));
console.log(`${imports.length} raw analysis checks and ${uiImports.length} UI import checks passed. ${audio.length} native audio comparisons passed.`);
console.log(`Largest sample error: ${Math.max(...audio.map(x=>x.maxSampleError))}`);
