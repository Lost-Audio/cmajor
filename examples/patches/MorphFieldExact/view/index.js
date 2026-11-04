import {decodeBlob,validate,MorphCore} from '../morph-core.js';
import {analyze,decodeWav,encodeViscoBlob} from '../visco-analysis.js';
import {defaults} from '../defaults.js';
import {effects} from '../effect-definitions.js';
import {oscillators} from '../oscillator-definitions.js';

const copy=m=>JSON.parse(JSON.stringify(m));
// Visco's UI saves the analysis as a blob, then loads that blob for playback.
// Match that rounding step too. Raw analysis coordinates produce a different attack.
export function importWav(buffer,name){
  const {samples,sampleRate}=decodeWav(buffer);
  const model=analyze(samples,sampleRate);
  if(!model)throw Error('The WAV file is silent.');
  return decodeBlob(encodeViscoBlob(model),name);
}
const sliders=[['morph','Morph',0,1,.5,.001],['level','Level',-36,6,0,.1],['tempo','Tempo',15,400,120,.1]];
const voiceSliders=[['polyphony','Voices',1,8,8,1],['release','Release',.01,10,.2,.01],['sustainPosition','Sustain position',.01,5,.1,.01],['keyTrack','Key track',0,100,100,1],['bendRange','Pitch bend',0,24,2,1],['stretch','Stretch',-100,100,0,.1]];
const legacySliders=[['limiterGain','Gain',0,48,0,.1],['limiterSpeed','Speed',0,100,50,1]];
const slots=[['send1','Send 1','send',0],['send2','Send 2','send',1],['main1','Main 1','main',4],['main2','Main 2','main',3]];
class MorphFieldView extends HTMLElement {
  constructor(connection){
    super();this.connection=connection;this.models=[copy(defaults[0]),copy(defaults[1])];this.mix=.5;this.loading=[0,0];
    this.values={oscillator:0};for(const [id,,,,value] of [...sliders,...voiceSliders,...legacySliders])this.values[id]=value;
    for(const [id,,bank,type] of slots){const p=effects[bank][type].parameters;Object.assign(this.values,{[id+'Type']:type,[id+'Enabled']:false,[id+'P1']:p[0].default,[id+'P2']:p[1].default,[id+'Amount']:0});}
    this.attachShadow({mode:'open'});
    const sources=[0,1].map(i=>`<div class="source" data-slot="${i}"><b>${i?'B':'A'}</b><span class="name"></span><label class="file">Load WAV or .blob<input type="file" accept=".wav,.blob,audio/wav" aria-label="Load source ${i?'B':'A'}"></label><button class="reset" title="Restore the built-in sound">Reset</button></div>`).join('');
    const controls=sliders.map(([id,label,min,max,value,step])=>`<label>${label}<output id="${id}-value"></output><input id="${id}" type="range" min="${min}" max="${max}" step="${step}" value="${value}" aria-label="${label}"></label>`).join('');
    const legacy=legacySliders.map(([id,label,min,max,value,step])=>`<label>${label}<output id="${id}-value"></output><input id="${id}" type="range" min="${min}" max="${max}" step="${step}" value="${value}" aria-label="Previous limiter ${label}"></label>`).join('');
    const voiceControls=voiceSliders.map(([id,label,min,max,value,step])=>`<label>${label}<output id="${id}-value"></output><input id="${id}" type="range" min="${min}" max="${max}" step="${step}" value="${value}" aria-label="${label}"></label>`).join('');
    const rack=slots.map(([id,title,bank,type])=>`<section class="effect" data-effect="${id}"><div class="effect-heading"><b>${title}</b><label><input id="${id}Enabled" type="checkbox" aria-label="${title} enabled">On</label></div><select id="${id}Type" aria-label="${title} effect">${effects[bank].map((e,i)=>`<option value="${i}" ${i===type?'selected':''}>${e.name}</option>`).join('')}</select>${[1,2].map(n=>`<label class="effect-control"><span id="${id}P${n}-label"></span><output id="${id}P${n}-value"></output><input id="${id}P${n}" type="range"></label>`).join('')}${bank==='send'?`<label class="effect-control"><span>Send</span><output id="${id}Amount-value">0%</output><input id="${id}Amount" type="range" min="0" max="4" value="0" step=".01" aria-label="${title} amount"></label>`:''}</section>`).join('');
    const noteNames=['C','C#','D','D#','E','F','F#','G','G#','A','A#','B','C'];
    const keys=noteNames.map((name,i)=>`<button class="key ${name.includes('#')?'sharp':''}" data-note="${60+i}" aria-label="Play ${name}${i===12?5:4}">${name}</button>`).join('');
    this.shadowRoot.innerHTML=`<style>
      :host{display:block;min-width:520px;height:100%;overflow:auto;color:#e8e5f2;background:#12151c;font:13px system-ui,sans-serif;box-sizing:border-box}
      *{box-sizing:border-box} main{padding:22px;max-width:1100px;margin:auto}header{display:flex;align-items:center;justify-content:space-between;margin-bottom:18px}
      h1{font-size:24px;font-weight:560;margin:0}header p{color:#a7a6b6;margin:4px 0 0}
      button,label.file{font:inherit;cursor:pointer;border:1px solid #414353;background:#222632;color:#edeaf7;border-radius:7px;padding:8px 12px}
      button:hover,label.file:hover{background:#34394a}button:focus-visible,input:focus-visible,label.file:focus-within{outline:2px solid #c4b5fd;outline-offset:3px}
      #play{background:#c6b7ff;color:#1b1630;border:0;font-weight:650;padding:11px 21px}
      .sources{display:grid;grid-template-columns:1fr 1fr;gap:12px}.source{border:1px solid #353a47;border-radius:10px;padding:12px;display:flex;align-items:center;gap:9px;min-width:0}
      .name{flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.file input{position:absolute;width:1px;height:1px;opacity:0}
      .field{position:relative;height:160px;margin:14px 0;border:1px solid #353a47;border-radius:12px;overflow:hidden;background:#10131a}
      canvas{width:100%;height:100%;display:block}.axis{position:absolute;font-size:11px;pointer-events:none;color:#aaa8bf;bottom:10px;left:14px;right:14px;display:flex;justify-content:space-between}
      .parameters{display:grid;grid-template-columns:repeat(3,1fr);gap:15px;margin:14px 0}.parameters label{display:block;color:#b9b5ca}.parameters output{display:block;color:#ede9fb;font-size:17px;margin:6px 0}.limiter-switch{display:flex;align-items:center;gap:8px;margin-top:10px;color:#d6ccec}.limiter-switch input{accent-color:#bea7ff}
      .effects{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:10px;margin-top:14px}.effect{padding:12px;border:1px solid #353a47;border-radius:10px;min-width:0}.effect-heading{display:flex;justify-content:space-between;align-items:center;margin-bottom:10px}.effect-heading label{display:flex;gap:4px;align-items:center;font-size:11px}.effect input[type=checkbox]{accent-color:#bea7ff}.effect select{width:100%;font:inherit;font-size:12px;background:#222632;color:#edeaf7;border:1px solid #414353;border-radius:5px;padding:7px 3px}.effect-control{display:grid;grid-template-columns:1fr auto;gap:6px;margin-top:11px;font-size:11px;color:#b9b5ca}.effect-control input{grid-column:1/-1}.effect-control output{color:#ede9fb}.hint{color:#9290a5;font-size:11px;margin:9px 0 13px;line-height:1.5}.legacy{border-top:1px solid #353a47;padding-top:9px;margin:12px 0}.legacy summary{cursor:pointer;color:#a7a6b6;font-size:11px}.legacy .parameters{grid-template-columns:1fr 1fr}.effect:has(input[type=checkbox]:checked){border-color:#8774b8}.effect select:focus-visible{outline:2px solid #c4b5fd;outline-offset:3px}@media(max-width:720px){.effects{grid-template-columns:1fr 1fr}.sources{grid-template-columns:1fr}.field{height:130px}}
      input[type=range]{width:100%;accent-color:#bea7ff;margin:0}.bottom{display:flex;align-items:center;justify-content:space-between;gap:16px}#status{color:#b9b5ca;max-width:55%;line-height:1.5;min-height:38px}
      .voice-panel{margin:12px 0;border:1px solid #353a47;border-radius:10px;padding:12px}.voice-heading{display:flex;align-items:center;justify-content:space-between}.voice-heading label{display:flex;align-items:center;gap:8px}.voice-heading input{accent-color:#bea7ff}.voice-shape{display:flex;align-items:center;gap:10px;margin-top:12px;color:#b9b5ca}.voice-shape select{font:inherit;background:#222632;color:#edeaf7;border:1px solid #414353;border-radius:5px;padding:7px;min-width:170px}.voice-controls{grid-template-columns:repeat(3,1fr);gap:12px}.voice-controls output{font-size:14px}.voice-panel[data-tonal=false] .voice-controls{opacity:.45}.key.sharp{background:#343044;color:#f3efff;height:34px}.keys{display:flex;gap:3px}.key{width:25px;height:44px;padding:0;background:#d4d0df;color:#24232d;font-size:10px}.key.pressed{background:#ad91f8}
    </style><main><header><div><h1>Morph Field Exact</h1><p>Load two sounds. Set the morph amount.</p></div><button id="play">Play sound</button></header>
    <section class="sources">${sources}</section>
    <div class="field"><canvas aria-label="Band amplitudes of the current morph. Time runs down."></canvas><div class="axis"><span>24 Hz</span><span>Time runs down</span><span>20 kHz</span></div></div>
    <section class="parameters">${controls}</section>
    <section class="voice-panel" data-tonal="false"><div class="voice-heading"><label><input id="tonal" type="checkbox">Tonal mode</label><button id="panic">Stop notes</button></div><label class="voice-shape">Oscillator<select id="oscillator" aria-label="Oscillator shape">${oscillators.map((name,index)=>`<option value="${index}">${name}</option>`).join('')}</select></label><section class="parameters voice-controls">${voiceControls}</section><p class="hint">Play chords with MIDI or the keys below. Sustain position holds a point in the sound.<br>Earlier positions can sustain brighter parts of a drum. Key track controls how the sound changes across notes.<br>Oscillator selects the harmonic pattern. Stretch changes the spacing between its frequencies.</p></section>
    <section class="effects" aria-label="Effects">${rack}</section>
    <p class="hint">Raise Send to hear a send effect. Main 1 feeds Main 2.<br>Tempo follows the host. Set it here for standalone use.</p>
    <details class="legacy"><summary>Previous limiter controls</summary><label class="limiter-switch"><input id="limiter" type="checkbox">Output limiter</label><section class="parameters">${legacy}</section></details>
    <div class="bottom"><div id="status" role="status">Load WAV files or Visco .blob files, or play the built-in pair.</div><div class="keys" aria-label="Trigger keys">${keys}</div></div></main>`;
  }
  $(s){return this.shadowRoot.querySelector(s);}
  connectedCallback(){
    this.abort=new AbortController();const options={signal:this.abort.signal};
    this.param=({endpointID,value})=>{this.values[endpointID]=value;const control=this.$('#'+endpointID);if(!control)return;if(control.type==='checkbox'){control.checked=Boolean(value);if(endpointID==='tonal')this.$('.voice-panel').dataset.tonal=String(Boolean(value));if(endpointID==='limiter'){const legacy=this.$('.legacy');legacy.querySelector('summary').textContent='Previous limiter controls'+(value?' (on)':'');if(value)legacy.open=true;}return;}const slot=slots.find(([id])=>endpointID.startsWith(id));if(slot){this.renderEffect(slot[0]);return;}control.value=value;if(endpointID==='oscillator')return;this.format(endpointID,Number(value));if(endpointID==='morph'){this.mix=Number(value);this.draw();}};
    this.hostTempo=value=>this.param({endpointID:'tempo',value});this.connection.addEndpointListener('hostTempo',this.hostTempo);
    this.state=({key,value})=>{const slot=key==='morphField.A'?0:key==='morphField.B'?1:-1;if(slot>=0&&validate(value)){this.models[slot]=value;this.refresh();}};
    this.ready=slot=>{this.$('#status').textContent=`Source ${slot?'B':'A'} is ready.`;};
    this.connection.addAllParameterListener(this.param);this.connection.addStoredStateValueListener(this.state);this.connection.addEndpointListener('modelReady',this.ready);
    this.connection.requestParameterValue('oscillator');
    this.$('#oscillator').addEventListener('change',e=>{const value=Number(e.target.value);this.connection.sendParameterGestureStart('oscillator');this.connection.sendEventOrValue('oscillator',value);this.param({endpointID:'oscillator',value});this.connection.sendParameterGestureEnd('oscillator');},options);
    this.connection.requestParameterValue('tonal');
    this.$('#tonal').addEventListener('change',e=>{this.connection.sendParameterGestureStart('tonal');this.connection.sendEventOrValue('tonal',e.target.checked);this.param({endpointID:'tonal',value:e.target.checked});this.connection.sendParameterGestureEnd('tonal');},options);
    this.$('#panic').addEventListener('click',()=>this.connection.sendEventOrValue('panic',1),options);
    this.connection.requestParameterValue('limiter');
    this.$('#limiter').addEventListener('change',e=>{this.connection.sendParameterGestureStart('limiter');this.connection.sendEventOrValue('limiter',e.target.checked);this.connection.sendParameterGestureEnd('limiter');},options);
    for(const [id] of [...sliders,...voiceSliders,...legacySliders]){
      const slider=this.$('#'+id);this.format(id,Number(slider.value));this.connection.requestParameterValue(id);
      slider.addEventListener('input',()=>{this.connection.sendEventOrValue(id,Number(slider.value));this.param({endpointID:id,value:Number(slider.value)});},options);
      for(const type of ['pointerdown','keydown'])slider.addEventListener(type,()=>this.connection.sendParameterGestureStart(id),options);
      for(const type of ['pointerup','pointercancel','keyup'])slider.addEventListener(type,()=>this.connection.sendParameterGestureEnd(id),options);
    }
    for(const [id,,bank] of slots){
      this.renderEffect(id);
      for(const suffix of ['Type','Enabled','P1','P2',...(bank==='send'?['Amount']:[])]){
        const endpoint=id+suffix,control=this.$('#'+endpoint);this.connection.requestParameterValue(endpoint);
        control.addEventListener(control.type==='range'?'input':'change',()=>{
          const value=control.type==='checkbox'?control.checked:Number(control.value);
          this.connection.sendParameterGestureStart(endpoint);this.connection.sendEventOrValue(endpoint,value);this.param({endpointID:endpoint,value});this.connection.sendParameterGestureEnd(endpoint);
          if(suffix==='Type')effects[bank][value].parameters.forEach((p,n)=>{const key=id+'P'+(n+1);this.connection.sendParameterGestureStart(key);this.connection.sendEventOrValue(key,p.default);this.param({endpointID:key,value:p.default});this.connection.sendParameterGestureEnd(key);});
        },options);
      }
    }
    this.connection.requestStoredStateValue('morphField.A');this.connection.requestStoredStateValue('morphField.B');
    this.$('#play').addEventListener('click',()=>{this.connection.sendEventOrValue('audition',1);clearTimeout(this.auditionOff);this.auditionActive=Boolean(this.values.tonal);if(this.auditionActive)this.auditionOff=setTimeout(()=>{this.connection.sendEventOrValue('audition',0);this.auditionActive=false;},400);},options);
    for(const card of this.shadowRoot.querySelectorAll('.source')){
      const slot=Number(card.dataset.slot);
      card.querySelector('.reset').addEventListener('click',()=>{this.models[slot]=copy(defaults[slot]);this.publish(slot);},options);
      card.querySelector('input').addEventListener('change',async e=>{const file=e.target.files[0];if(file)await this.load(slot,file);e.target.value='';},options);
      card.addEventListener('dragover',e=>e.preventDefault(),options);
      card.addEventListener('drop',e=>{e.preventDefault();const file=e.dataTransfer.files[0];if(file)this.load(slot,file);},options);
    }
    for(const key of this.shadowRoot.querySelectorAll('.key')){
      const note=Number(key.dataset.note);
      key.addEventListener('pointerdown',e=>{e.preventDefault();key.setPointerCapture(e.pointerId);key.classList.add('pressed');this.connection.sendMIDIInputEvent('midiIn',(0x90<<16)|(note<<8)|100);},options);
      key.addEventListener('keydown',e=>{if((e.key==='Enter'||e.key===' ')&&!e.repeat){e.preventDefault();key.classList.add('pressed');this.connection.sendMIDIInputEvent('midiIn',(0x90<<16)|(note<<8)|100);}},options);
      const off=()=>{if(key.classList.contains('pressed')){key.classList.remove('pressed');this.connection.sendMIDIInputEvent('midiIn',(0x80<<16)|(note<<8));}};
      key.addEventListener('keyup',e=>{if(e.key==='Enter'||e.key===' '){e.preventDefault();off();}},options);
      key.addEventListener('blur',off,options);
      for(const type of ['pointerup','pointercancel','lostpointercapture'])key.addEventListener(type,off,options);
    }
    this.resize=new ResizeObserver(()=>this.draw());this.resize.observe(this.$('canvas'));this.refresh();
  }
  disconnectedCallback(){clearTimeout(this.auditionOff);if(this.auditionActive)this.connection.sendEventOrValue('audition',0);for(const key of this.shadowRoot.querySelectorAll('.key.pressed'))this.connection.sendMIDIInputEvent('midiIn',(0x80<<16)|(Number(key.dataset.note)<<8));this.abort?.abort();this.resize?.disconnect();this.loading[0]++;this.loading[1]++;
    this.connection.removeAllParameterListener(this.param);this.connection.removeStoredStateValueListener(this.state);this.connection.removeEndpointListener('modelReady',this.ready);this.connection.removeEndpointListener('hostTempo',this.hostTempo);}
  format(id,value){
    if(voiceSliders.some(([key])=>key===id)){this.$('#'+id+'-value').textContent=id==='polyphony'?String(Math.round(value)):id==='stretch'?value.toFixed(1):id==='keyTrack'?Math.round(value)+'%':id==='bendRange'?Math.round(value)+' st':value.toFixed(2)+' s';return;}
    this.$('#'+id+'-value').textContent=id==='morph'?`${Math.round(value*100)}% B`:id==='limiterSpeed'?`${Math.round(value)}%`:id==='tempo'?`${value.toFixed(1)} BPM`:`${value.toFixed(1)} dB`;}
  renderEffect(id){
    const slot=slots.find(s=>s[0]===id),type=Math.max(0,Math.min(effects[slot[2]].length-1,Math.round(Number(this.values[id+'Type']))));
    this.$('#'+id+'Type').value=type;
    effects[slot[2]][type].parameters.forEach((p,n)=>{const key=id+'P'+(n+1),control=this.$('#'+key),value=Math.max(p.min,Math.min(p.max,Number(this.values[key])));this.$('#'+key+'-label').textContent=p.name;control.min=p.min;control.max=p.max;control.step=p.step;control.value=value;control.setAttribute('aria-label',slot[1]+' '+p.name);this.$('#'+key+'-value').textContent=`${Number(value.toFixed(2))}${p.unit===':1'?':1':p.unit?' '+p.unit:''}`;});
    if(slot[2]==='send'){const v=Number(this.values[id+'Amount']);this.$('#'+id+'Amount').value=v;this.$('#'+id+'Amount-value').textContent=Math.round(v*100)+'%';}
  }
  publish(slot){this.connection.sendStoredStateValue(slot?'morphField.B':'morphField.A',this.models[slot]);this.refresh();}
  refresh(){for(const card of this.shadowRoot.querySelectorAll('.source'))card.querySelector('.name').textContent=this.models[Number(card.dataset.slot)].name;this.draw();}
  async load(slot,file){
    const token=++this.loading[slot];
    try{
      if(file.size>100*1024*1024)throw Error('Choose a file smaller than 100 MB.');
      const buffer=await file.arrayBuffer();
      const model=file.name.toLowerCase().endsWith('.blob')?decodeBlob(buffer,file.name):importWav(buffer,file.name);
      if(token!==this.loading[slot]||!this.isConnected)return;
      this.models[slot]=model;this.publish(slot);
      this.$('#status').textContent=`Source ${slot?'B':'A'} loaded. Sending it to the engine.`;
    }catch(error){if(token===this.loading[slot]&&this.isConnected)this.$('#status').textContent=error.message||'The file could not be read.';}
  }
  draw(){
    const canvas=this.$('canvas');if(!canvas)return;const bounds=canvas.getBoundingClientRect();if(!bounds.width)return;
    const dpr=window.devicePixelRatio||1;canvas.width=Math.round(bounds.width*dpr);canvas.height=Math.round(bounds.height*dpr);
    const ctx=canvas.getContext('2d');ctx.scale(dpr,dpr);const w=bounds.width,h=bounds.height;
    ctx.fillStyle='#10131a';ctx.fillRect(0,0,w,h);
    // Rows follow model time: linear for the attack and logarithmic for the tail, as in Visco.
    let rows;
    try{const core=new MorphCore(this.models[0],this.models[1],this.mix);rows=Array.from({length:64},()=>core.step(95/64).output.map(x=>x*x));}
    catch{return;}
    const peak=Math.max(1e-12,...rows.flat()),image=new ImageData(80,64);
    rows.forEach((row,y)=>row.forEach((a,x)=>{const v=Math.sqrt(Math.min(1,a/peak));image.data.set([20+v*165,24+v*133,34+v*205,255],(y*80+x)*4);}));
    const off=document.createElement('canvas');off.width=80;off.height=64;off.getContext('2d').putImageData(image,0,0);
    ctx.imageSmoothingEnabled=true;ctx.drawImage(off,0,0,w,h);
  }
}
export default function createPatchView(connection){if(!customElements.get('morph-field-exact-view'))customElements.define('morph-field-exact-view',MorphFieldView);return new (customElements.get('morph-field-exact-view'))(connection);}
