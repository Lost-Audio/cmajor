// Numerical reference for the neutral coordinate morph. No DLL is required at runtime.
export const BANDS=80, TIME_POINTS=41, FREQ_POINTS=49;
const f=Math.fround;
const add=(a,b)=>f(a+b),sub=(a,b)=>f(a-b),mul=(a,b)=>f(a*b),div=(a,b)=>f(a/b);
export const clamp=(x,a,b)=>Math.max(a,Math.min(b,x));
export const TIME_FLOOR=f(.17585784196853638),FREQ_FLOOR=f(.25220587849617004);

export function decodeBlob(buffer,name='Imported model') {
 const b=new DataView(buffer.buffer||buffer,buffer.byteOffset||0,buffer.byteLength);
 if(b.byteLength!==1137||b.getUint8(0)>1)throw Error('Choose a supported 1,137-byte Visco blob.');
 let offset=1;
 const read=(rows,count)=>Array.from({length:rows},()=>{
  const curve=[0];for(let q=1;q<count;q++,offset+=2)curve.push(add(curve[q-1],mul(b.getUint16(offset,true),f(64/65535))));return curve;
 });
 const time=read(7,41),frequency=read(6,49);
 for(const curve of time)constrainCurve(curve,96);
 for(const curve of frequency)constrainCurve(curve,80);
 const m={version:1,name:name.slice(0,100),time,frequency};
 if(!validate(m))throw Error('The model has unsupported or collapsed curves.');
 m.norm=normalization(m);return m;
}
export function constrainCurve(p,extent){
 const count=p.length,lo=mul(div(7.5,count),f(.4117646813392639)),hi=div(div(mul(extent,f(1.15)),count),f(.4117646813392639));
 const forward=p.slice(),backward=p.slice(),end=p[count-1];
 for(let i=1;i<count-1;i++)forward[i]=Math.min(clamp(p[i],add(forward[i-1],lo),add(forward[i-1],hi)),add(end,mul(i-count+1,lo)));
 for(let i=count-2;i>0;i--){backward[i]=Math.max(clamp(p[i],sub(backward[i+1],hi),sub(backward[i+1],lo)),mul(i,lo));p[i]=mul(add(forward[i],backward[i]),.5);}
}
export function encodeBlob(m) {
 const bytes=new Uint8Array(1137),v=new DataView(bytes.buffer);bytes[0]=1;let o=1;
 for(const row of [...m.time,...m.frequency])for(let i=1;i<row.length;i++,o+=2)
  v.setUint16(o,clamp(Math.round((row[i]-row[i-1])/(64/65535)),0,65535),true);
 return bytes;
}
export function validate(m) {
 const curves=(a,n,k,end)=>Array.isArray(a)&&a.length===n&&a.every(p=>Array.isArray(p)&&p.length===k&&p[0]===0&&
   p.every((v,i)=>Number.isFinite(v)&&v>=0&&v<=end+.02&&(!i||v>p[i-1]))&&Math.abs(p[k-1]-end)<.02);
 return m?.version===1&&typeof m.name==='string'&&curves(m.time,7,41,96)&&curves(m.frequency,6,49,80);
}
// Stateful inverse of a monotone landmark curve. Matches the rational interpolator.
export class CurveReader {
 constructor(a,b=a,mix=0,timeMode=false){this.a=a;this.b=b;this.mix=f(mix);this.timeMode=timeMode;
  const w=this.interval(0);Object.assign(this,{index:-1,width:w,nextWidth:w,base:f(-w),slope:0,nextSlope:div(1,w),quadratic:0,shape:0,sum:0});}
 interval(i){return add(mul(sub(this.a[i+1],this.a[i]),sub(1,this.mix)),mul(sub(this.b[i+1],this.b[i]),this.mix));}
 read(x){
  x=f(x);if(x<this.a[0])return 0;
  while(this.index<this.a.length-1){
   const w=this.width;if(x<add(this.base,w))break;
   this.base=add(this.base,w);this.index++;
   this.sum=add(mul(add(mul(w,this.quadratic),this.slope),w),this.sum);
   this.slope=this.nextSlope;this.width=this.nextWidth;
   let next=this.interval(Math.min(this.index+1,this.a.length-2));
   if(!this.timeMode)next=Math.max(next,f(1e-9));
   this.nextWidth=next;
   const now=this.width;
   this.nextSlope=div(add(mul(next,next),mul(now,now)),mul(mul(next,now),add(next,now)));
   let shape=mul(add(div(.5,w),div(.5,next)),now);
   this.shape=mul(sub(mul(shape,shape),1),f(.2));
   this.quadratic=div(sub(this.nextSlope,mul(add(this.shape,1),this.slope)),mul(add(this.shape,2),now));
  }
  x=sub(x,this.base);const w=this.width;
  let numerator=mul(add(mul(x,this.quadratic),this.slope),mul(mul(w,w),x));
  let denominator=add(mul(mul(x,this.shape),sub(w,x)),mul(w,w));
  if(this.timeMode){numerator=Math.max(numerator,f(1e-30));denominator=Math.max(denominator,mul(numerator,.5));}
  return add(div(numerator,denominator),this.sum);
 }
}
export function normalization(m){
 const grid=Array.from({length:6},()=>Array(7).fill(0));
 for(let t=0;t<6;t++)for(let q=1;q<48;q++){
  const p=m.frequency[t],w=mul(sub(p[q+1],p[q-1]),.5),v=Math.max(0,sub(div(1,w),FREQ_FLOOR));
  const u=mul(sub(q,.5),.125),k=Math.floor(u),z=sub(u,k);
  const tilt=add(mul(mul(sub(f(.63),div(p[q],80)),sub(f(.63),div(p[q],80))),8),1);
  const energy=mul(mul(mul(mul(mul(div(1,mul(tilt,tilt)),v),v),v),v),w);
  grid[t][k]=add(grid[t][k],mul(sub(1,z),energy));grid[t][k+1]=add(grid[t][k+1],mul(z,energy));
 }
 let norm=0;
 for(let r=0;r<7;r++){
  let sum=0;const p=m.time[r];
  for(let q=1;q<40;q++){
   const w=mul(sub(p[q+1],p[q-1]),.5),v=Math.max(0,sub(div(1,w),TIME_FLOOR));
   const u=mul(sub(q,.5),.125),k=Math.floor(u),z=sub(u,k);
   const energy=add(mul(sub(1,z),grid[k][r]),mul(z,grid[k+1][r]));
   sum=add(sum,mul(mul(mul(mul(mul(energy,v),v),v),v),w));
  }
  norm=add(norm,f(Math.sqrt(Math.max(0,sum))));
 }
 return norm;
}
export class MorphCore {
 constructor(a,b,mix,gain=1){this.a=a;this.b=b;this.time=0;this.previous=Array(7).fill(0);this.gain=gain;this.progress=Array(7).fill(0);this.rate=Array(7).fill(0);this.tailSeed=123;
  this.readers=a.time.map((p,i)=>new CurveReader(p,b.time[i],mix,true));
  this.setMix(mix);}
 setMix(mix){
  if(!Number.isFinite(mix))throw Error('Morph must be a finite number.');
  this.mix=f(clamp(mix,0,1));for(const r of this.readers)r.mix=this.mix;
  this.norm=div(this.gain,Math.max(f(1e-6),add(mul(f(Math.sqrt(this.a.norm??normalization(this.a))),sub(1,this.mix)),mul(f(Math.sqrt(this.b.norm??normalization(this.b))),this.mix))));
 }
 step(delta){
  delta=f(delta);const oldTime=this.time;this.time=add(this.time,delta);if(!(delta>0))throw Error('Use positive time steps.');
  const {progress,rate}=this;
  if(this.time<96)for(let r=0;r<7;r++){
   const p=this.readers[r].read(this.time);
   rate[r]=clamp(sub(mul(sub(p,this.previous[r]),div(1,delta)),TIME_FLOOR),0,20);
   progress[r]=clamp(mul(p,.125),0,f(4.999));this.previous[r]=p;
  }
  else{
   const step=div(sub(linearTime(this.time),linearTime(oldTime)),689.0625);
   for(let r=0;r<7;r++){
    const tau=Math.max(f(.001),add(mul(sub(1,this.mix),this.a.tail[r]),mul(this.mix,this.b.tail[r])));
    rate[r]=mul(div(tau,add(tau,step)),rate[r]);
    let seed=this.tailSeed;seed=(seed^(seed<<5))>>>0;seed=(seed^(seed>>>7))>>>0;this.tailSeed=seed;
    progress[r]=clamp(add(progress[r],mul(sub(mul(f(seed),f(2.3283000527563047e-10)),.5),f(.01))),f(3.999),f(4.999));
   }
  }
  const frequency=[];
  for(let q=0;q<48;q++){
   const r=Math.floor(q/8),z=mul(q%8,.125),u=add(mul(sub(1,z),progress[r]),mul(z,progress[r+1]));
   const t=Math.floor(u),v=sub(u,t);
   const lo=add(mul(this.mix,this.b.frequency[t][q]),mul(sub(1,this.mix),this.a.frequency[t][q]));
   const hi=add(mul(this.mix,this.b.frequency[t+1][q]),mul(sub(1,this.mix),this.a.frequency[t+1][q]));
   frequency[q]=add(mul(lo,sub(1,v)),mul(hi,v));
  }
  frequency[48]=80;
  const reader=new CurveReader(frequency),output=[],densities=[];let previous=reader.read(0),cell=0;
  for(let band=0;band<80;band++){const current=reader.read(band+1);densities[band]=sub(current,previous);previous=current;}
  frequency[48]=f(80.001);
  for(let band=0;band<80;band++){
   const density=densities[band];
   while(cell<47&&frequency[cell+1]<band)cell++;
   const u=mul(add(div(sub(band,frequency[cell]),sub(frequency[cell+1],frequency[cell])),cell),.125);
   const r=clamp(Math.floor(u),0,5),z=sub(u,r);
   const speed=add(mul(sub(1,z),rate[r]),mul(z,rate[r+1]));
   output[band]=mul(mul(speed,Math.max(0,sub(density,FREQ_FLOOR))),this.norm);
  }
  return {output,frequency,progress,rate};
 }
}
const logBase=f(Math.log(f(1.04))),offset=f(Math.pow(f(1.04),-25));
export const modelTime=t=>t<25?t:div(f(Math.log(div(t,mul(offset,25)))),logBase);
export const linearTime=t=>t<25?t:mul(f(Math.exp(mul(logBase,t))),mul(offset,25));
export function modelStats(m){
 let duration=0;const tail=[];
 for(const p of m.time){let last=41;for(let q=40;q>0;q--)if(sub(p[q],p[q-1])<f(5.629547595977783)){last=q;duration=Math.max(duration,add(p[q],1));break;}
  if(last<39){tail.push(0);continue;}
  const times=[],levels=[];for(let j=0;j<2;j++){let k=40-j*4;times.push(div(linearTime(mul(add(p[k-2],p[k]),.5)),689.0625));levels.push(Math.max(add(mul(j,f(.001)),f(1e-9)),sub(div(2,sub(p[k],p[k-2])),TIME_FLOOR)));}
  tail.push(div(sub(times[0],times[1]),f(Math.log2(Math.max(f(1.01),div(levels[1],levels[0]))))));
 }m.duration=duration;m.tail=tail;return m;
}
