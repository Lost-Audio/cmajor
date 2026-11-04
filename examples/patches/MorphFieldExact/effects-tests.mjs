import fs from'node:fs';import path from'node:path';import vm from'node:vm';import{execFileSync}from'node:child_process';import{gunzipSync}from'node:zlib';import{fileURLToPath}from'node:url';
const root=path.dirname(fileURLToPath(import.meta.url)),artifacts=path.join(root,'test-artifacts'),fixture=path.join(root,'fixtures/effects');fs.mkdirSync(artifacts,{recursive:true});
const types=['Chorus','Diffuser','Plate','Room','Spring','Delay','Compressor','Fuzz','Sticky','Optical','Upward','Limiter','Tape','Transformer'];
const fields=types.map((name,i)=>`${i===11?'ViscoDynamics':'ViscoEffects'}::${name} core${i};`).join('\n');
fs.writeFileSync(path.join(artifacts,'EffectsProbe.cmajor'),`processor EffectsProbe [[main]] {
 input stream float<2> source;output stream float<2> out;
 input event int effect;input event float parameter1,parameter2,bpm;
 int kind=11;float p1=0.0f,p2=50.0f;${fields}
 void configure(){${types.map((_,i)=>`if(kind==${i})core${i}.configure(float(processor.frequency),p1,p2);`).join('')}}
 event effect(int v){kind=v;configure();}event parameter1(float v){p1=v;configure();}event parameter2(float v){p2=v;configure();}event bpm(float v){core5.tempo=v;}
 void init(){${types.map((_,i)=>`core${i}.reset();`).join('')}configure();}
 void main(){loop{var y=source;${types.map((_,i)=>`if(kind==${i})y=core${i}.process(source);`).join('')}out <- y;advance();}}
}`);
const source=['WaveData.cmajor','ViscoLimiter.cmajor','ViscoEffects.cmajor','ViscoSpace.cmajor','ViscoSpringData.cmajor','ViscoSpring.cmajor'].map(p=>'../'+p);
fs.writeFileSync(path.join(artifacts,'EffectsProbe.cmajorpatch'),JSON.stringify({CmajorVersion:1,ID:'local.effects-test',version:'1.0',name:'Effects test',source:[...source,'EffectsProbe.cmajor']}));
try{execFileSync('cmaj',['generate','--target=javascript','--output=effects-probe.js','EffectsProbe.cmajorpatch'],{cwd:artifacts,stdio:'pipe',maxBuffer:8*1024*1024});}catch(e){fs.writeFileSync(path.join(artifacts,'effects-compile.log'),e.stderr||'');throw Error('Effect test did not compile. See test-artifacts/effects-compile.log.');}
const Engine=vm.runInNewContext(fs.readFileSync(path.join(artifacts,'effects-probe.js'),'utf8')+'\nEffectsProbe;',{WebAssembly,TextDecoder,TextEncoder,console,atob});
const read=name=>{const b=gunzipSync(fs.readFileSync(path.join(fixture,name)));return Float32Array.from({length:b.length/4},(_,i)=>b.readFloatLE(i*4));};
const input=[read('input-left.f32.gz'),read('input-right.f32.gz')],reference=JSON.parse(fs.readFileSync(path.join(fixture,'reference.json'))),results=[];
for(const c of reference.cases){
 const engine=new Engine();await engine.initialise(reference.seed,c.rate);
 engine.sendInputEvent_effect(c.bank===0?c.type:8+c.type);engine.sendInputEvent_parameter1(c.p1);engine.sendInputEvent_parameter2(c.p2);engine.sendInputEvent_bpm(c.tempo);
 const actual=[new Float32Array(c.frames),new Float32Array(c.frames)],sizes=[1,3,7,64,127];let block=0;
 for(let pos=0;pos<c.frames;){
  for(const change of c.changes||[])if(pos===change[0]){engine.sendInputEvent_parameter1(change[1]);engine.sendInputEvent_parameter2(change[2]);if(change.length>3)engine.sendInputEvent_bpm(change[3]);}
  let n=Math.min(sizes[block++%sizes.length],c.frames-pos);for(const change of c.changes||[])if(change[0]>pos)n=Math.min(n,change[0]-pos);
  engine.setInputStreamFrames_source(input.map(x=>x.subarray(pos,pos+n)),n,0);engine.advance(n);engine.getOutputFrames_out(actual.map(x=>x.subarray(pos,pos+n)),n,0);pos+=n;
 }
 let max=0,error=0,power=0,peak=0,different=0,finite=true;
 for(let ch=0;ch<2;ch++){const expected=read(ch?c.right:c.left);for(let i=0;i<c.frames;i++){const d=actual[ch][i]-expected[i];finite&&=Number.isFinite(d);max=Math.max(max,Math.abs(d));peak=Math.max(peak,Math.abs(expected[i]));error+=d*d;power+=expected[i]*expected[i];if(d)different++;}}
 const residual=error?10*Math.log10(error/power):null;
 const passed=finite&&max<=Math.max(1,peak)*0.00003&&(residual===null||residual<-100);
 results.push({name:c.id,effect:types[c.bank===0?c.type:8+c.type],rate:c.rate,parameter1:c.p1,parameter2:c.p2,automation:Boolean(c.changes),passed,maxSampleError:max,peak,differentSamples:different,differenceDb:residual});
 if(!passed)console.log('FAILED',results.at(-1));
}
const passed=results.every(r=>r.passed),report={passed,version:reference.version,seed:reference.seed,nativeBlockSize:64,hostBlockSizes:[1,3,7,64,127],results};
fs.writeFileSync(path.join(root,'effects-test-results.json'),JSON.stringify(report,null,2));
if(!passed)throw Error(results.filter(r=>!r.passed).length+' native effect comparisons failed.');
console.log(results.length+' native effect comparisons passed. '+results.filter(r=>r.differentSamples===0).length+' cases match every sample.');
console.log('Largest sample error: '+Math.max(...results.map(r=>r.maxSampleError)));
console.log('Largest residual: '+Math.max(...results.filter(r=>r.differenceDb!==null).map(r=>r.differenceDb))+' dB');
