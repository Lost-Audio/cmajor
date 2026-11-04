import fs from 'node:fs';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {gunzipSync} from 'node:zlib';
import {fileURLToPath} from 'node:url';
import {decodeBlob,modelStats} from './morph-core.js';

const root=path.dirname(fileURLToPath(import.meta.url));
const referenceFolder=process.argv[2]??'polyphony';
const cases=JSON.parse(fs.readFileSync(path.join(root,'fixtures',referenceFolder,'reference.json'))).cases;
const selected=referenceFolder==='polyphony'
    ?cases.filter(test=>['tonal-48000-36','tonal-48000-60','tonal-chord','tonal-overlap','tonal-steal'].includes(test.id))
    :cases.filter(test=>test.id.startsWith('shape-48000-')||test.id.includes('automation')||(/^stretch-(-100|100)-(0|6|10)$/.test(test.id)));
const literal=value=>Number.isInteger(value)?value+'.0f':value.toPrecision(10)+'f';
const array=(name,values)=>`let ${name}=float[${values.length}](${values.map(literal).join(',')});\n`;
const manifest=JSON.parse(fs.readFileSync(path.join(root,'MorphFieldExact.cmajorpatch')));
const results=[];

for(const test of selected) {
    const destination=path.join(root,'test-artifacts',test.id+'-native');
    fs.mkdirSync(destination,{recursive:true});
    const model=modelStats(decodeBlob(fs.readFileSync(path.join(root,'fixtures',test.model))));
    fs.writeFileSync(path.join(destination,'Defaults.cmajor'),'namespace CoreDefaults{'
        +array('time',[...model.time.flat(),...model.time.flat()])
        +array('frequency',[...model.frequency.flat(),...model.frequency.flat()])
        +array('norm',[model.norm,model.norm])+array('duration',[model.duration,model.duration])
        +array('tail',[...model.tail,...model.tail])+'}');
    const parameters=[['bool','tonal','true'],['int','polyphony',test.polyphony],
        ['float','morph','0.0f'],['float','level','0.0f'],
        ['float','release',literal(test.release)],['float','sustainPosition',literal(test.sustainPosition)],
        ['float','keyTrack',literal(test.keyTrack)],['int','oscillator',test.oscillator??0],['float','stretch',literal(test.stretch??0)]];
    let schedule='',previous=0;
    for(const event of test.events) {
        if(event.frame>previous)schedule+=`loop(${event.frame-previous})advance();`;
        if(event.parameter)schedule+=`${event.parameter} <- ${event.parameter==='oscillator'?event.value:literal(event.value)};`;
        else {
            const message=(((event.velocity>0?0x90:0x80)|event.channel)<<16)|(event.note<<8)|Math.round(event.velocity*127);
            schedule+=`midiOut <- std::midi::Message(${message});`;
        }
        previous=event.frame;
    }
    let source=fs.readFileSync(path.join(root,'MorphFieldExact.cmajor'),'utf8').replace('[[ main ]]','');
    source+=`\nprocessor TonalTrigger{
        output event std::midi::Message midiOut;
        ${parameters.map(([type,id])=>`output event ${type} ${id};`).join('\n')}
        void main(){${parameters.map(([,id,value])=>`${id} <- ${value};`).join('')}${schedule}loop{advance();}}
    }
    graph TonalNative [[main]]{
        output stream float<2> out;
        node player=MorphFieldExact;node trigger=TonalTrigger;
        connection trigger.midiOut -> player.midiIn;
        ${parameters.map(([,id])=>`connection trigger.${id} -> player.${id};`).join('\n')}
        connection player.out -> out;
    }`;
    fs.writeFileSync(path.join(destination,'Probe.cmajor'),source);
    const dependencies=manifest.source.filter(name=>!['Defaults.cmajor','MorphFieldExact.cmajor'].includes(name)).map(name=>'../../'+name);
    fs.writeFileSync(path.join(destination,'Probe.cmajorpatch'),JSON.stringify({CmajorVersion:1,ID:'local.native-tonal',version:'1',name:'Native tonal test',source:['Defaults.cmajor',...dependencies,'Probe.cmajor']}));
    try {
        execFileSync('cmaj',['render','-O2','--rate='+test.rate,'--length='+(test.frames+32768),'--output=render.wav','Probe.cmajorpatch'],{cwd:destination,stdio:'pipe',maxBuffer:8*1024*1024});
    } catch(error) {
        fs.writeFileSync(path.join(destination,'render.log'),error.stderr??String(error));
        throw Error('Native tonal render failed. See '+destination);
    }
    const wav=fs.readFileSync(path.join(destination,'render.wav'));
    let data,format,bits,channels;
    for(let offset=12;offset+8<=wav.length;) {
        const length=wav.readUInt32LE(offset+4),tag=wav.toString('ascii',offset,offset+4);
        if(tag==='fmt ') {
            format=wav.readUInt16LE(offset+8);channels=wav.readUInt16LE(offset+10);bits=wav.readUInt16LE(offset+22);
            if(format===65534)format=wav.readUInt16LE(offset+32);
        }
        if(tag==='data')data=wav.subarray(offset+8,offset+8+length);
        offset+=8+length+(length&1);
    }
    if(format!==3||bits!==32||channels!==2)throw Error('Expected stereo float output');
    const expected=gunzipSync(fs.readFileSync(path.join(root,'fixtures',referenceFolder,test.id+'.f32.gz')));
    let onset=0,referenceOnset=0;
    while(onset<data.length/8&&data.readFloatLE(onset*8)===0)onset++;
    while(referenceOnset<test.frames&&expected.readFloatLE(referenceOnset*4)===0)referenceOnset++;
    const startup=onset-referenceOnset;
    if(startup<0||startup>32768||startup%512!==0)throw Error('Unexpected CLI startup silence');
    let maximum=0,error=0,power=0;
    for(let i=0;i<test.frames;i++) {
        const value=expected.readFloatLE(i*4),difference=data.readFloatLE((startup+i)*8)-value;
        maximum=Math.max(maximum,Math.abs(difference));error+=difference*difference;power+=value*value;
    }
    const residualDb=10*Math.log10(error/power);
    results.push({id:test.id,maxSampleError:maximum,residualDb,cliStartupFrames:startup,passed:maximum<.0001&&residualDb<-95});
    console.log(results.at(-1));
}
fs.writeFileSync(path.join(root,'native-'+referenceFolder+'-test-results.json'),JSON.stringify({passed:results.every(test=>test.passed),results},null,2));
if(results.some(test=>!test.passed))throw Error('Native tonal comparison failed');
