import fs from'node:fs';import path from'node:path';import{execFileSync}from'node:child_process';import{gunzipSync}from'node:zlib';import{fileURLToPath}from'node:url';import{decodeBlob,modelStats}from'./morph-core.js';
const root=path.dirname(fileURLToPath(import.meta.url)),fixture=path.join(root,'fixtures/effects'),cases=JSON.parse(fs.readFileSync(path.join(fixture,'rack-reference.json'))),results=[];
const model=modelStats(decodeBlob(fs.readFileSync(path.join(root,'fixtures/ui-phase-kick.blob')))),f=x=>Number.isInteger(x)?x+'.0f':x.toPrecision(10)+'f';
const data=(name,values)=>`let ${name}=float[${values.length}](${values.map(f).join(',')});\n`;
for(const c of cases){
 const dest=path.join(root,'test-artifacts',c.id+'-native');fs.mkdirSync(dest,{recursive:true});
 fs.writeFileSync(path.join(dest,'Defaults.cmajor'),'namespace CoreDefaults{'+data('time',[...model.time.flat(),...model.time.flat()])+data('frequency',[...model.frequency.flat(),...model.frequency.flat()])+data('norm',[model.norm,model.norm])+data('duration',[model.duration,model.duration])+data('tail',[...model.tail,...model.tail])+'}');
 const events=[['float','morph','0.0f'],['float','level','0.0f'],['bool','limiter','false']];
 for(const [i,id]of ['send1','send2','main1','main2'].entries()){events.push(['int',id+'Type',String(c.settings.types[i])],['float',id+'P1',f(c.settings.parameter1[i])],['float',id+'P2',f(c.settings.parameter2[i])],['bool',id+'Enabled','true']);if(i<2)events.push(['float',id+'Amount',f(c.settings.sends[i])]);}
 let source=fs.readFileSync(path.join(root,'MorphFieldExact.cmajor'),'utf8').replace('[[ main ]]','');
 source+=`\nprocessor RackTrigger{output event float audition;${events.map(([type,id])=>`output event ${type} ${id};`).join('')}void main(){${events.map(([,id,value])=>`${id} <- ${value};`).join('')}loop(${c.preRoll})advance();audition <- 1.0f;loop{advance();}}}\ngraph RackNative [[main]]{output stream float<2> out;node player=MorphFieldExact;node trigger=RackTrigger;connection trigger.audition -> player.audition;${events.map(([,id])=>`connection trigger.${id} -> player.${id};`).join('')}connection player.out -> out;}`;
 fs.writeFileSync(path.join(dest,'Probe.cmajor'),source);
 const dependencies=JSON.parse(fs.readFileSync(path.join(root,'MorphFieldExact.cmajorpatch'))).source.filter(x=>!['Defaults.cmajor','MorphFieldExact.cmajor'].includes(x)).map(x=>'../../'+x);
 fs.writeFileSync(path.join(dest,'Probe.cmajorpatch'),JSON.stringify({CmajorVersion:1,ID:'local.native-rack',version:'1.0',name:'Native rack test',source:['Defaults.cmajor',...dependencies,'Probe.cmajor']}));
 try{const log=execFileSync('cmaj',['render','-O2','--rate='+c.rate,'--length='+(c.frames+c.preRoll+32768),'--output=render.wav','Probe.cmajorpatch'],{cwd:dest,encoding:'utf8',stdio:'pipe',maxBuffer:8*1024*1024});fs.writeFileSync(path.join(dest,'render.log'),log);}catch(e){fs.writeFileSync(path.join(dest,'render.log'),e.stderr||'');throw Error('Native rack render failed.');}
 const wav=fs.readFileSync(path.join(dest,'render.wav'));let bytes,bits,code,channels;
 for(let p=12;p+8<=wav.length;){const n=wav.readUInt32LE(p+4),tag=wav.toString('ascii',p,p+4);if(tag==='fmt '){code=wav.readUInt16LE(p+8);channels=wav.readUInt16LE(p+10);bits=wav.readUInt16LE(p+22);if(code===65534)code=wav.readUInt16LE(p+32);}if(tag==='data')bytes=wav.subarray(p+8,p+8+n);p+=8+n+(n&1);}
 if(code!==3||bits!==32||channels!==2)throw Error('Expected stereo float WAV.');
 const expected=['left','right'].map(side=>{const b=gunzipSync(fs.readFileSync(path.join(fixture,c.id+'-'+side+'.f32.gz')));return new Float32Array(b.buffer.slice(b.byteOffset,b.byteOffset+b.byteLength));});
 let onset=0;while(onset<bytes.length/8&&bytes.readFloatLE(onset*8)===0)onset++;
 const startup=onset-expected[0].findIndex(x=>x!==0);if(startup<c.preRoll||(startup-c.preRoll)%512!==0||startup>32768+c.preRoll)throw Error('Unexpected native startup offset.');
 let max=0,error=0,power=0;for(let ch=0;ch<2;ch++)for(let i=0;i<c.frames;i++){const d=bytes.readFloatLE((startup+i)*8+ch*4)-expected[ch][i];max=Math.max(max,Math.abs(d));error+=d*d;power+=expected[ch][i]*expected[ch][i];}
 const differenceDb=10*Math.log10(error/power);results.push({name:c.id,passed:max<.00001&&differenceDb<-115,maxSampleError:max,differenceDb,cliStartupFrames:startup-c.preRoll,preRoll:c.preRoll,signalOffset:0});
}
fs.writeFileSync(path.join(root,'native-rack-test-results.json'),JSON.stringify({passed:results.every(r=>r.passed),results},null,2));console.table(results);if(results.some(r=>!r.passed))throw Error('Native rack audio comparison failed.');
