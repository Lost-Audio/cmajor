import {decodeBlob,validate,MorphCore} from '../morph-core.js';
import {analyze,decodeWav,encodeViscoBlob} from '../visco-analysis.js';
import {defaults} from '../defaults.js';

const copy=m=>JSON.parse(JSON.stringify(m));
// Visco's UI saves the analysis as a blob, then loads that blob for playback.
// Match that rounding step too. Raw analysis coordinates produce a different attack.
export function importWav(buffer,name){
  const {samples,sampleRate}=decodeWav(buffer);
  const model=analyze(samples,sampleRate);
  if(!model)throw Error('The WAV file is silent.');
  return decodeBlob(encodeViscoBlob(model),name);
}
const sliders=[['morph','Morph',0,1,.5,.001],['level','Level',-36,6,0,.1],['limiterGain','Limiter Gain',0,48,0,.1],['limiterSpeed','Limiter Speed',0,100,50,1]];
class MorphFieldView extends HTMLElement {
  constructor(connection){
    super();this.connection=connection;this.models=[copy(defaults[0]),copy(defaults[1])];this.mix=.5;this.loading=[0,0];
    this.attachShadow({mode:'open'});
    const sources=[0,1].map(i=>`<div class="source" data-slot="${i}"><b>${i?'B':'A'}</b><span class="name"></span><label class="file">Load WAV or .blob<input type="file" accept=".wav,.blob,audio/wav" aria-label="Load source ${i?'B':'A'}"></label><button class="reset" title="Restore the built-in sound">Reset</button></div>`).join('');
    const controls=sliders.map(([id,label,min,max,value,step])=>`<label>${label}<output id="${id}-value"></output><input id="${id}" type="range" min="${min}" max="${max}" step="${step}" value="${value}" aria-label="${label}"></label>`).join('');
    const keys=Array.from({length:8},(_,i)=>`<button class="key" data-note="${60+i}" aria-label="Trigger note ${60+i}">${i?'':'C4'}</button>`).join('');
    this.shadowRoot.innerHTML=`<style>
      :host{display:block;min-width:520px;height:100%;color:#e8e5f2;background:#12151c;font:13px system-ui,sans-serif;box-sizing:border-box}
      *{box-sizing:border-box} main{padding:22px;max-width:1100px;margin:auto}header{display:flex;align-items:center;justify-content:space-between;margin-bottom:18px}
      h1{font-size:24px;font-weight:560;margin:0}header p{color:#a7a6b6;margin:4px 0 0}
      button,label.file{font:inherit;cursor:pointer;border:1px solid #414353;background:#222632;color:#edeaf7;border-radius:7px;padding:8px 12px}
      button:hover,label.file:hover{background:#34394a}button:focus-visible,input:focus-visible,label.file:focus-within{outline:2px solid #c4b5fd;outline-offset:3px}
      #play{background:#c6b7ff;color:#1b1630;border:0;font-weight:650;padding:11px 21px}
      .sources{display:grid;grid-template-columns:1fr 1fr;gap:12px}.source{border:1px solid #353a47;border-radius:10px;padding:12px;display:flex;align-items:center;gap:9px;min-width:0}
      .name{flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.file input{position:absolute;width:1px;height:1px;opacity:0}
      .field{position:relative;height:260px;margin:14px 0;border:1px solid #353a47;border-radius:12px;overflow:hidden;background:#10131a}
      canvas{width:100%;height:100%;display:block}.axis{position:absolute;font-size:11px;pointer-events:none;color:#aaa8bf;bottom:10px;left:14px;right:14px;display:flex;justify-content:space-between}
      .parameters{display:grid;grid-template-columns:repeat(4,1fr);gap:15px;margin:18px 0}.parameters label{display:block;color:#b9b5ca}.parameters output{display:block;color:#ede9fb;font-size:17px;margin:6px 0}.limiter-switch{display:flex;align-items:center;gap:8px;margin-top:14px;color:#d6ccec}.limiter-switch input{accent-color:#bea7ff}.limiter-switch small{color:#aaa8bf}
      input[type=range]{width:100%;accent-color:#bea7ff;margin:0}.bottom{display:flex;align-items:center;justify-content:space-between;gap:16px}#status{color:#b9b5ca;max-width:55%;line-height:1.5;min-height:38px}
      .keys{display:flex;gap:3px}.key{width:25px;height:44px;padding:0;background:#d4d0df;color:#24232d;font-size:10px}.key.pressed{background:#ad91f8}
    </style><main><header><div><h1>Morph Field Exact</h1><p>Load two sounds. Set the morph amount.</p></div><button id="play">Play sound</button></header>
    <section class="sources">${sources}</section>
    <div class="field"><canvas aria-label="Band amplitudes of the current morph. Time runs down."></canvas><div class="axis"><span>24 Hz</span><span>Time runs down</span><span>20 kHz</span></div></div>
    <label class="limiter-switch"><input id="limiter" type="checkbox">Limiter <small>Visco output effect</small></label>
    <section class="parameters">${controls}</section>
    <div class="bottom"><div id="status" role="status">Load WAV files or Visco .blob files, or play the built-in pair.</div><div class="keys" aria-label="Trigger keys">${keys}</div></div></main>`;
  }
  $(s){return this.shadowRoot.querySelector(s);}
  connectedCallback(){
    this.abort=new AbortController();const options={signal:this.abort.signal};
    this.param=({endpointID,value})=>{const slider=this.$('#'+endpointID);if(!slider)return;if(endpointID==='limiter'){slider.checked=Boolean(value);return;}slider.value=value;this.format(endpointID,Number(value));if(endpointID==='morph'){this.mix=Number(value);this.draw();}};
    this.state=({key,value})=>{const slot=key==='morphField.A'?0:key==='morphField.B'?1:-1;if(slot>=0&&validate(value)){this.models[slot]=value;this.refresh();}};
    this.ready=slot=>{this.$('#status').textContent=`Source ${slot?'B':'A'} is ready.`;};
    this.connection.addAllParameterListener(this.param);this.connection.addStoredStateValueListener(this.state);this.connection.addEndpointListener('modelReady',this.ready);
    this.connection.requestParameterValue('limiter');
    this.$('#limiter').addEventListener('change',e=>{this.connection.sendParameterGestureStart('limiter');this.connection.sendEventOrValue('limiter',e.target.checked);this.connection.sendParameterGestureEnd('limiter');},options);
    for(const [id] of sliders){
      const slider=this.$('#'+id);this.format(id,Number(slider.value));this.connection.requestParameterValue(id);
      slider.addEventListener('input',()=>{this.connection.sendEventOrValue(id,Number(slider.value));this.param({endpointID:id,value:Number(slider.value)});},options);
      for(const type of ['pointerdown','keydown'])slider.addEventListener(type,()=>this.connection.sendParameterGestureStart(id),options);
      for(const type of ['pointerup','pointercancel','keyup'])slider.addEventListener(type,()=>this.connection.sendParameterGestureEnd(id),options);
    }
    this.connection.requestStoredStateValue('morphField.A');this.connection.requestStoredStateValue('morphField.B');
    this.$('#play').addEventListener('click',()=>this.connection.sendEventOrValue('audition',1),options);
    for(const card of this.shadowRoot.querySelectorAll('.source')){
      const slot=Number(card.dataset.slot);
      card.querySelector('.reset').addEventListener('click',()=>{this.models[slot]=copy(defaults[slot]);this.publish(slot);},options);
      card.querySelector('input').addEventListener('change',async e=>{const file=e.target.files[0];if(file)await this.load(slot,file);e.target.value='';},options);
      card.addEventListener('dragover',e=>e.preventDefault(),options);
      card.addEventListener('drop',e=>{e.preventDefault();const file=e.dataTransfer.files[0];if(file)this.load(slot,file);},options);
    }
    for(const key of this.shadowRoot.querySelectorAll('.key')){
      const note=Number(key.dataset.note);
      key.addEventListener('pointerdown',()=>{key.classList.add('pressed');this.connection.sendMIDIInputEvent('midiIn',(0x90<<16)|(note<<8)|100);},options);
      const off=()=>{if(key.classList.contains('pressed')){key.classList.remove('pressed');this.connection.sendMIDIInputEvent('midiIn',(0x80<<16)|(note<<8));}};
      for(const type of ['pointerup','pointercancel','pointerleave'])key.addEventListener(type,off,options);
    }
    this.resize=new ResizeObserver(()=>this.draw());this.resize.observe(this.$('canvas'));this.refresh();
  }
  disconnectedCallback(){this.abort?.abort();this.resize?.disconnect();this.loading[0]++;this.loading[1]++;
    this.connection.removeAllParameterListener(this.param);this.connection.removeStoredStateValueListener(this.state);this.connection.removeEndpointListener('modelReady',this.ready);}
  format(id,value){this.$('#'+id+'-value').textContent=id==='morph'?`${Math.round(value*100)}% B`:id==='limiterSpeed'?`${Math.round(value)}%`:`${value.toFixed(1)} dB`;}
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
