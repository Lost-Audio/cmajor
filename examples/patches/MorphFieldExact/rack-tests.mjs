import fs from'node:fs';import path from'node:path';import vm from'node:vm';import{execFileSync}from'node:child_process';import{gunzipSync}from'node:zlib';import{fileURLToPath}from'node:url';import{decodeBlob,modelStats}from'./morph-core.js';
const root=path.dirname(fileURLToPath(import.meta.url)),artifacts=path.join(root,'test-artifacts'),fixture=path.join(root,'fixtures/effects');
try{execFileSync('cmaj',['generate','--target=javascript','--output=test-artifacts/rack-engine.js','MorphFieldExact.cmajorpatch'],{cwd:root,stdio:'pipe',maxBuffer:8*1024*1024});}catch(e){fs.writeFileSync(path.join(artifacts,'rack-compile.log'),e.stderr||'');throw Error('Rack test did not compile.');}
const Engine=vm.runInNewContext(fs.readFileSync(path.join(artifacts,'rack-engine.js'),'utf8')+'\nMorphFieldExact;',{WebAssembly,TextDecoder,TextEncoder,console,atob});
const cases=JSON.parse(fs.readFileSync(path.join(fixture,'rack-reference.json'))),m=modelStats(decodeBlob(fs.readFileSync(path.join(root,'fixtures/ui-phase-kick.blob')))),results=[];
for(const c of cases){
 const e=new Engine();await e.initialise(2345,c.rate);
 for(let slot=0;slot<2;slot++){for(let i=0;i<7;i++)e.sendInputEvent_modelCurve({slot,kind:0,index:i,positions:[...m.time[i],...Array(8).fill(0)]});for(let i=0;i<6;i++)e.sendInputEvent_modelCurve({slot,kind:1,index:i,positions:m.frequency[i]});e.sendInputEvent_modelInfo({slot,norm:m.norm,duration:m.duration,tail:m.tail});}
 e.sendInputEvent_morph(0);e.sendInputEvent_level(0);e.sendInputEvent_limiter(false);
 const ids=['send1','send2','main1','main2'];for(let i=0;i<4;i++){const id=ids[i];e['sendInputEvent_'+id+'Type'](c.settings.types[i]);e['sendInputEvent_'+id+'P1'](c.settings.parameter1[i]);e['sendInputEvent_'+id+'P2'](c.settings.parameter2[i]);if(i<2)e['sendInputEvent_'+id+'Amount'](c.settings.sends[i]);e['sendInputEvent_'+id+'Enabled'](true);}
 for(let p=0;p<c.preRoll;p+=64)e.advance(64);e.sendInputEvent_audition(1);
 const actual=[new Float32Array(c.frames),new Float32Array(c.frames)];for(let p=0;p<c.frames;p+=64){const n=Math.min(64,c.frames-p);e.advance(n);e.getOutputFrames_out(actual.map(x=>x.subarray(p,p+n)),n,0);}
 let max=0,error=0,power=0,peak=0;for(let ch=0;ch<2;ch++){const expected=gunzipSync(fs.readFileSync(path.join(fixture,c.id+(ch?'-right':'-left')+'.f32.gz')));for(let i=0;i<c.frames;i++){const ref=expected.readFloatLE(i*4),d=actual[ch][i]-ref;max=Math.max(max,Math.abs(d));error+=d*d;power+=ref*ref;peak=Math.max(peak,Math.abs(ref));}fs.writeFileSync(path.join(artifacts,c.id+'-candidate-'+ch+'.f32'),Buffer.from(actual[ch].buffer));}
 const differenceDb=10*Math.log10(error/power),passed=max<Math.max(1,peak)*.00005&&differenceDb<-100;results.push({name:c.id,passed,maxSampleError:max,differenceDb,peak});
}
fs.writeFileSync(path.join(root,'rack-test-results.json'),JSON.stringify({passed:results.every(r=>r.passed),results},null,2));console.table(results);if(results.some(r=>!r.passed))throw Error('Full native rack comparison failed.');
