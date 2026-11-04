import fs from'node:fs';import{spawn}from'node:child_process';import{fileURLToPath}from'node:url';
const root=fileURLToPath(new URL('.',import.meta.url)),artifacts=new URL('test-artifacts/',import.meta.url);fs.mkdirSync(artifacts,{recursive:true});
fs.writeFileSync(new URL('EffectsViewProbe.js',artifacts),`
import createView from '../view/index.js';
export default function(connection){
 const check=(condition,message)=>{if(!condition)throw Error(message);};
 let view=createView(connection),stage=0,values={},timer;
 document.body.append(view);
 const read=id=>view.shadowRoot.getElementById(id);
 const change=(id,value)=>{const control=read(id);if(control.type==='checkbox')control.checked=value;else control.value=value;control.dispatchEvent(new Event(control.type==='range'?'input':'change',{bubbles:true}));};
 function verify(){
  try{
   if(stage===0){
    check(view.shadowRoot.querySelectorAll('.effect').length===4,'Four effect slots');
    check(read('send1Type').options.length===8&&read('main1Type').options.length===6,'Effect menus');
    change('send1Type',4);change('send1Enabled',true);change('send1Amount',.35);
    change('main1Type',5);change('main1P2',-55);change('main1Enabled',true);change('limiter',true);
    change('tonal',true);change('polyphony',6);change('release',.35);change('sustainPosition',.06);change('keyTrack',75);change('bendRange',12);
    check(read('oscillator').options.length===12,'Twelve oscillator shapes');
    change('oscillator',10);change('stretch',-45);
    stage=1;timer=setTimeout(verify,400);
   }else if(stage===1){
    check(values.send1Type===4&&values.send1Enabled&&Math.abs(values.send1Amount-.35)<.0001,'Send values reached the engine');
    check(values.main1Type===5&&values.main1P1===12&&values.main1P2===-55&&values.main1Enabled,'Main values reached the engine');
    check(values.tonal&&values.polyphony===6&&Math.abs(values.release-.35)<.0001,'Voice values reached the engine');
    check(values.oscillator===10&&values.stretch===-45,'Shape and Stretch reached the engine');
    view.remove();view=createView(connection);document.body.append(view);stage=2;timer=setTimeout(verify,400);
   }else{
    check(Number(read('send1Type').value)===4&&read('send1Enabled').checked,'Send state restored');
    check(Number(read('main1Type').value)===5&&Number(read('main1P2').value)===-55,'Main state restored');
    check(read('main1P2-label').textContent==='Bias','Dynamic control label restored');
    check(read('main1P2').min==='-100'&&read('main1P2').max==='100','Dynamic control range restored');
    check(view.shadowRoot.querySelector('.legacy').open,'Active previous limiter stays visible');
    check(read('tonal').checked&&Number(read('polyphony').value)===6,'Voice mode restored');
    check(Math.abs(Number(read('sustainPosition').value)-.06)<.0001&&Number(read('keyTrack').value)===75&&Number(read('bendRange').value)===12,'Voice controls restored');
    check(view.shadowRoot.querySelectorAll('.key').length===13,'Chromatic keys');
    check(Number(read('oscillator').value)===10&&Number(read('stretch').value)===-45,'Shape and Stretch restored');
    connection.sendEventOrValue('tempoIn',{bpm:137});
    setTimeout(()=>{try{check(Number(read('tempo').value)===137,'Host tempo reached the view');console.info('EFFECTS_VIEW_OK '+JSON.stringify({slots:4,sendEffects:8,mainEffects:6,restored:true,hostTempo:137}));}catch(e){console.error('EFFECTS_VIEW_ERROR '+e.message);}},150);
   }
  }catch(e){console.error('EFFECTS_VIEW_ERROR '+e.message);}
 }
 connection.addAllParameterListener(({endpointID,value})=>values[endpointID]=value);
 for(const id of ['send1Type','send1Enabled','send1Amount','main1Type','main1P1','main1P2','main1Enabled'])connection.requestParameterValue(id);
 timer=setTimeout(verify,400);
}
`);
const manifest=new URL('EffectsViewProbe.cmajorpatch',import.meta.url),source=JSON.parse(fs.readFileSync(new URL('MorphFieldExact.cmajorpatch',import.meta.url))).source;
fs.writeFileSync(manifest,JSON.stringify({CmajorVersion:1,ID:'local.effects-view-test',version:'1.0',name:'Effects view test',source,worker:'test-artifacts/EffectsViewProbe.js'}));
const result=await new Promise((resolve,reject)=>{
 const child=spawn('cmaj',['play','--no-gui','--worker=webview','--stop-on-error','EffectsViewProbe.cmajorpatch'],{cwd:root,windowsHide:true});let stdout='',stderr='',done=false;
 const timeout=setTimeout(()=>finish(Error('Effect view test timed out.')),25000);
 function finish(error){if(done)return;done=true;clearTimeout(timeout);child.kill();fs.writeFileSync(new URL('effects-view-probe.log',artifacts),stdout+stderr);if(error)reject(error);else resolve({passed:true,...JSON.parse(stdout.match(/EFFECTS_VIEW_OK (\{[^\r\n]+\})/)[1])});}
 child.stdout.on('data',b=>{stdout+=b;if(stdout.includes('EFFECTS_VIEW_ERROR'))finish(Error(stdout));else if(stdout.includes('EFFECTS_VIEW_OK'))finish();});child.stderr.on('data',b=>{stderr+=b;if(stderr.includes('EFFECTS_VIEW_ERROR'))finish(Error(stderr));});child.on('error',finish);child.on('exit',code=>{if(!done)finish(Error('Effect view host exited: '+code+' '+stderr.slice(-1000)));});
}).finally(()=>fs.rmSync(manifest,{force:true}));
fs.writeFileSync(new URL('effects-view-test-results.json',import.meta.url),JSON.stringify(result,null,2));console.log(result);
