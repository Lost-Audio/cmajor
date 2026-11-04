import fs from 'node:fs';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import assert from 'node:assert/strict';
const dir=fileURLToPath(new URL('.',import.meta.url));fs.mkdirSync(new URL('test-artifacts/',import.meta.url),{recursive:true});
fs.writeFileSync(new URL('test-artifacts/WorkerProbe.js',import.meta.url),`
import worker from '../worker.js';
import {defaults} from '../defaults.js';
export default function(connection){
 const start=Date.now(),ready=new Set(),parameters=new Map();let done=false;
 function check(){if(!done&&ready.size===2&&parameters.size===3){done=true;console.info('PARAMETERS_OK '+JSON.stringify(Object.fromEntries(parameters)));console.info('UPLOAD_OK '+(Date.now()-start));}}
 connection.addEndpointListener('modelReady',slot=>{ready.add(slot);check();});
 connection.addAllParameterListener(({endpointID,value})=>{if(['limiter','limiterGain','limiterSpeed'].includes(endpointID)){parameters.set(endpointID,value);check();}});
 for(const id of ['limiter','limiterGain','limiterSpeed'])connection.requestParameterValue(id);
 worker(connection);
 connection.sendStoredStateValue('morphField.A',defaults[0]);
 connection.sendStoredStateValue('morphField.B',defaults[1]);
}
`);
const manifest=new URL('WorkerProbe.cmajorpatch',import.meta.url);
const patchManifest=JSON.parse(fs.readFileSync(new URL('MorphFieldExact.cmajorpatch',import.meta.url)));
fs.writeFileSync(manifest,JSON.stringify({CmajorVersion:1,ID:'local.morphfieldexact.worker-test',version:'1.0',name:'Worker test',source:patchManifest.source,worker:'test-artifacts/WorkerProbe.js'}));
const result=await new Promise((resolve,reject)=>{
 const child=spawn('cmaj',['play','--no-gui','--worker=webview','--stop-on-error','WorkerProbe.cmajorpatch'],{cwd:dir,windowsHide:true});
 let stdout='',stderr='',finished=false;
 const timer=setTimeout(()=>finish(Error('The model upload did not complete.')),15000);
 function finish(error){if(finished)return;finished=true;clearTimeout(timer);child.kill();
  fs.writeFileSync(new URL('test-artifacts/worker-probe.log',import.meta.url),stdout+stderr);
  error?reject(error):resolve({passed:true,uploadRoundTripMs:Number(stdout.match(/UPLOAD_OK (\d+)/)[1])});}
 child.stdout.on('data',b=>{stdout+=b;if(/UPLOAD_OK (\d+)/.test(stdout))finish();});
 child.stderr.on('data',b=>stderr+=b);
 child.on('error',finish);child.on('exit',code=>{if(!finished)finish(Error('Worker host exited: '+code+' '+stderr));});
}).finally(()=>fs.rmSync(manifest,{force:true}));
assert.ok(result.passed);const log=fs.readFileSync(new URL('test-artifacts/worker-probe.log',import.meta.url),'utf8');
const parameters=JSON.parse(log.match(/PARAMETERS_OK (\{[^\r\n]+\})/)[1]);assert.equal(Boolean(parameters.limiter),false);assert.equal(parameters.limiterGain,0);assert.equal(parameters.limiterSpeed,50);
result.limiterParameters=parameters;fs.writeFileSync(new URL('worker-test-results.json',import.meta.url),JSON.stringify(result,null,2));console.log(result);
