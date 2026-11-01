import fs from'node:fs';import path from'node:path';import vm from'node:vm';import assert from'node:assert/strict';import{execFileSync}from'node:child_process';import{fileURLToPath}from'node:url';
const root=path.dirname(fileURLToPath(import.meta.url)),artifacts=path.join(root,'test-artifacts'),fixtures=path.join(root,'fixtures');fs.mkdirSync(artifacts,{recursive:true});
fs.writeFileSync(path.join(artifacts,'LimiterProbe.cmajor'),`processor LimiterProbe [[main]] {
 input stream float<2> source;output stream float<2> out;input event float gain,speed;
 ViscoDynamics::Limiter effect;float db=0.0f,rateValue=50.0f;
 void configure(){effect.configure(float(processor.frequency),db,rateValue);}
 event gain(float v){db=v;configure();}event speed(float v){rateValue=v;configure();}
 void init(){effect.reset();configure();}void main(){loop{out <- effect.process(source);advance();}}
}`);
fs.writeFileSync(path.join(artifacts,'LimiterProbe.cmajorpatch'),JSON.stringify({CmajorVersion:1,ID:'local.limiter-test',version:'1.0',name:'Limiter test',source:['../ViscoLimiter.cmajor','LimiterProbe.cmajor']}));
execFileSync('cmaj',['generate','--target=javascript','--output=limiter.js','LimiterProbe.cmajorpatch'],{cwd:artifacts,stdio:'pipe'});
const Engine=vm.runInNewContext(fs.readFileSync(path.join(artifacts,'limiter.js'),'utf8')+'\nLimiterProbe;',{WebAssembly,TextDecoder,TextEncoder,console,atob});
const reference=JSON.parse(fs.readFileSync(path.join(fixtures,'limiter-reference.json'))),results=[];
for(const c of reference.cases){
 const engine=new Engine();await engine.initialise(2345,c.rate);engine.sendInputEvent_gain(c.gain);engine.sendInputEvent_speed(c.speed);
 const bytes=fs.readFileSync(path.join(fixtures,c.input)),expected=fs.readFileSync(path.join(fixtures,c.audio));
 const input=Float32Array.from({length:bytes.length/4},(_,i)=>bytes.readFloatLE(4*i)),left=new Float32Array(input.length),right=new Float32Array(input.length);
 const rightBytes=c.rightInput?fs.readFileSync(path.join(fixtures,c.rightInput)):bytes;
 const rightInput=Float32Array.from({length:rightBytes.length/4},(_,i)=>rightBytes.readFloatLE(4*i));
 const expectedRight=c.rightAudio?fs.readFileSync(path.join(fixtures,c.rightAudio)):expected;
 const sizes=[1,3,7,64,127];let block=0;
 for(let pos=0;pos<input.length;){const n=Math.min(sizes[block++%sizes.length],input.length-pos);engine.setInputStreamFrames_source([input.subarray(pos,pos+n),rightInput.subarray(pos,pos+n)],n,0);engine.advance(n);engine.getOutputFrames_out([left.subarray(pos,pos+n),right.subarray(pos,pos+n)],n,0);pos+=n;}
 let max=0,different=0,error=0,power=0;
 for(const [actual,reference]of[[left,expected],[right,expectedRight]])for(let i=0;i<input.length;i++){const ref=reference.readFloatLE(4*i),d=actual[i]-ref;assert.ok(Number.isFinite(actual[i]));max=Math.max(max,Math.abs(d));if(d)different++;error+=d*d;power+=ref*ref;}
 assert.ok(max<0.000001,c.id+': limiter error '+max);assert.ok(error===0||10*Math.log10(power/error)>115,c.id+': limiter residual');
 results.push({name:c.id,rate:c.rate,gain:c.gain,speed:c.speed,maxSampleDifference:max,differentSamples:different,differenceDb:error?10*Math.log10(error/power):null});
}
fs.writeFileSync(path.join(root,'limiter-test-results.json'),JSON.stringify({passed:true,results},null,2));console.table(results);
