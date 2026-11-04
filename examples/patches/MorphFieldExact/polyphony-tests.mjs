import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {gunzipSync} from 'node:zlib';
import {fileURLToPath} from 'node:url';
import {decodeBlob,modelStats} from './morph-core.js';

const root=fileURLToPath(new URL('.',import.meta.url));
fs.mkdirSync(root+'test-artifacts',{recursive:true});
execFileSync('cmaj',['generate','--target=javascript','--output='+root+'test-artifacts/poly-engine.js',root+'MorphFieldExact.cmajorpatch'],{stdio:'pipe'});
const Engine=vm.runInNewContext(fs.readFileSync(root+'test-artifacts/poly-engine.js','utf8')+'\nMorphFieldExact;',{WebAssembly,TextDecoder,TextEncoder,console,atob});
const referenceFolder=process.argv[2]??'polyphony';
const reference=JSON.parse(fs.readFileSync(root+'fixtures/'+referenceFolder+'/reference.json'));
const midi=(type,note,value,channel=0)=>({message:((type|channel)<<16)|(note<<8)|value});

async function setup(settings={}) {
    const engine=new Engine();
    await engine.initialise(2345,settings.rate??48000);
    const model=modelStats(decodeBlob(fs.readFileSync(root+'fixtures/'+(settings.model??'ui-phase-kick.blob'))));
    for(let slot=0;slot<2;slot++) {
        for(let index=0;index<7;index++)engine.sendInputEvent_modelCurve({slot,kind:0,index,positions:[...model.time[index],...Array(8).fill(0)]});
        for(let index=0;index<6;index++)engine.sendInputEvent_modelCurve({slot,kind:1,index,positions:model.frequency[index]});
        engine.sendInputEvent_modelInfo({slot,norm:model.norm,duration:model.duration,tail:model.tail});
    }
    engine.sendInputEvent_morph(0);
    engine.sendInputEvent_level(0);
    engine.sendInputEvent_tonal(true);
    engine.sendInputEvent_polyphony(settings.polyphony??8);
    engine.sendInputEvent_release(settings.release??.05);
    engine.sendInputEvent_sustainPosition(settings.sustainPosition??.03);
    engine.sendInputEvent_keyTrack(settings.keyTrack??100);
    engine.sendInputEvent_oscillator(settings.oscillator??0);
    engine.sendInputEvent_stretch(settings.stretch??0);
    return engine;
}

function render(engine,frames,events=[],blockSize=127) {
    const left=new Float32Array(frames),right=new Float32Array(frames);
    let next=0;
    for(let position=0;position<frames;) {
        while(next<events.length&&events[next].frame===position) {
            const event=events[next++];
            if(event.parameter)engine['sendInputEvent_'+event.parameter](event.value);
            else engine.sendInputEvent_midiIn(event.message??midi(event.velocity>0?0x90:0x80,event.note,Math.round(event.velocity*127),event.channel));
        }
        let count=Math.min(blockSize,frames-position);
        if(next<events.length)count=Math.min(count,events[next].frame-position);
        assert.ok(count>0,'Events must have increasing frame positions');
        engine.advance(count);
        engine.getOutputFrames_out([left.subarray(position,position+count),right.subarray(position,position+count)],count,0);
        position+=count;
    }
    assert.ok(left.every(Number.isFinite),'Finite output');
    assert.deepEqual(left,right,'Neutral stereo');
    return left;
}

const native=[];
for(const test of reference.cases) {
    const actual=render(await setup(test),test.frames,test.events);
    const expected=gunzipSync(fs.readFileSync(root+'fixtures/'+referenceFolder+'/'+test.id+'.f32.gz'));
    assert.equal(expected.length,actual.byteLength);
    let maximum=0,error=0,power=0;
    for(let i=0;i<actual.length;i++) {
        const value=expected.readFloatLE(4*i),difference=actual[i]-value;
        maximum=Math.max(maximum,Math.abs(difference));
        error+=difference*difference;
        power+=value*value;
    }
    const residual=10*Math.log10(error/power);
    native.push({id:test.id,maxSampleError:maximum,residualDb:residual});
    console.log(test.id,maximum,residual);
    assert.ok(maximum<.0001&&residual<-95,`${test.id}: native difference`);
}

const power=data=>data.reduce((sum,value)=>sum+value*value,0);
const on=(frame,note,channel=0)=>({frame,message:midi(0x90,note,127,channel)});
const off=(frame,note,channel=0)=>({frame,message:midi(0x80,note,0,channel)});
const control=(frame,number,value,channel=0)=>({frame,message:midi(0xb0,number,value,channel)});
const behavior=[];

// A held note must sustain beyond the original kick's duration.
let engine=await setup();
let audio=render(engine,72000,[on(0,60)]);
assert.ok(power(audio.subarray(60000))>.01,'Held note stays audible');
behavior.push('Held note sustains');

// Velocity zero must release a note. The test also checks pedal release.
engine=await setup();
audio=render(engine,48000,[on(0,60),control(4096,64,127),{frame:8192,message:midi(0x90,60,0)},control(24000,64,0)]);
assert.ok(power(audio.subarray(12000,22000))>.01,'Pedal holds released key');
assert.ok(power(audio.subarray(36000))<1e-12,'Pedal release ends note');
behavior.push('Velocity zero and sustain pedal');

// Note release must affect only its MIDI channel.
engine=await setup();
audio=render(engine,48000,[on(0,60,0),on(0,60,1),off(8192,60,0),off(24000,60,1)]);
assert.ok(power(audio.subarray(16000,22000))>.01,'Other channel keeps playing');
assert.ok(power(audio.subarray(36000))<1e-12,'Both channels finish');
behavior.push('Channel-specific note release');

// Half of a twelve-semitone bend must match a note six semitones higher.
engine=await setup();engine.sendInputEvent_bendRange(12);
const bent=render(engine,8192,[{frame:0,message:midi(0xe0,0,96)},on(0,60)]);
const pitched=render(await setup(),8192,[on(0,66)]);
assert.deepEqual(bent,pitched,'Pitch bend reaches the oscillator');
behavior.push('Pitch bend tuning');

// Repeated notes and voice replacement must remain bounded and releasable.
engine=await setup({polyphony:2});
const busy=Array.from({length:16},(_,i)=>on(i*512,48+i));
busy.push(control(16384,123,0));
audio=render(engine,32000,busy,7);
assert.ok(Math.max(...audio.map(Math.abs))<32,'Voice replacement stays bounded');
assert.ok(power(audio.subarray(24000))<1e-12,'All Notes Off releases replacements');
behavior.push('Voice replacement and All Notes Off');

engine=await setup();render(engine,4096,[on(0,60)]);engine.sendInputEvent_panic(1);
assert.equal(power(render(engine,4096)),0,'Stop notes clears voices');
behavior.push('Stop notes');

const result={passed:true,native,behavior};
fs.writeFileSync(root+referenceFolder+'-test-results.json',JSON.stringify(result,null,2));
console.log(`${native.length} native tonal comparisons and ${behavior.length} MIDI behavior checks passed.`);
