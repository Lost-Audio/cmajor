import fs from'node:fs';import path from'node:path';import vm from'node:vm';import{execFileSync}from'node:child_process';import{gunzipSync}from'node:zlib';import{fileURLToPath}from'node:url';
const root=path.dirname(fileURLToPath(import.meta.url)),artifacts=path.join(root,'test-artifacts'),fixture=path.join(root,'fixtures/effects');
const source=JSON.parse(fs.readFileSync(path.join(root,'MorphFieldExact.cmajorpatch'))).source.filter(f=>!['Defaults.cmajor','MorphFieldExact.cmajor'].includes(f)).map(f=>'../'+f);
fs.writeFileSync(path.join(artifacts,'BypassProbe.cmajor'),`processor BypassProbe [[main]]{input stream float<2> source;output stream float<2> out;input event int type;input event float p1,p2;input event bool enabled;ViscoEffects::MainSlot slot;int64 seed=2345L;void init(){slot.setup(float(processor.frequency),3,12.0f,20.0f);slot.enabled=true;}event type(int v){slot.select(v);}event p1(float v){slot.p1=v;slot.configure();}event p2(float v){slot.p2=v;slot.configure();}event enabled(bool v){slot.enabled=v;}void main(){loop{out <- slot.process(source,seed);advance();}}}`);
fs.writeFileSync(path.join(artifacts,'BypassProbe.cmajorpatch'),JSON.stringify({CmajorVersion:1,ID:'local.bypass-test',version:'1.0',name:'Bypass test',source:[...source,'BypassProbe.cmajor']}));
execFileSync('cmaj',['generate','--target=javascript','--output=bypass-probe.js','BypassProbe.cmajorpatch'],{cwd:artifacts,stdio:'pipe',maxBuffer:8*1024*1024});
const Engine=vm.runInNewContext(fs.readFileSync(path.join(artifacts,'bypass-probe.js'),'utf8')+'\nBypassProbe;',{WebAssembly,TextDecoder,TextEncoder,console,atob});
const read=n=>{const b=gunzipSync(fs.readFileSync(path.join(fixture,n)));return new Float32Array(b.buffer.slice(b.byteOffset,b.byteOffset+b.byteLength));};
const inputs=[read('input-left.f32.gz'),read('input-right.f32.gz')],results=[];
for(const c of JSON.parse(fs.readFileSync(path.join(fixture,'bypass-reference.json')))){
 const e=new Engine();await e.initialise(2345,c.rate);e.sendInputEvent_type(c.type);e.sendInputEvent_p1(c.p1);e.sendInputEvent_p2(c.p2);const actual=inputs.map(x=>new Float32Array(x.length));
 for(let pos=0;pos<inputs[0].length;pos+=64){for(const change of c.bypass)if(change[0]===pos)e.sendInputEvent_enabled(Boolean(change[1]));e.setInputStreamFrames_source(inputs.map(x=>x.subarray(pos,pos+64)),64,0);e.advance(64);e.getOutputFrames_out(actual.map(x=>x.subarray(pos,pos+64)),64,0);}
 let max=0,error=0,power=0,different=0;for(let ch=0;ch<2;ch++){const ref=read(c.id+(ch?'-right':'-left')+'.f32.gz');for(let i=0;i<ref.length;i++){const d=actual[ch][i]-ref[i];max=Math.max(max,Math.abs(d));error+=d*d;power+=ref[i]*ref[i];if(d)different++;}}
 const differenceDb=error?10*Math.log10(error/power):null;results.push({name:c.id,passed:max<.000001&&(differenceDb===null||differenceDb<-115),maxSampleError:max,differenceDb,differentSamples:different});
}
fs.writeFileSync(path.join(root,'bypass-test-results.json'),JSON.stringify({passed:results.every(r=>r.passed),results},null,2));console.table(results);if(results.some(r=>!r.passed))throw Error('Native bypass comparison failed.');
