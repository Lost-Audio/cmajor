// Port of Visco 2.0.3 sample import (RVA 0x64e10 and its helpers). It turns mono samples into a
// 7x41 time and 6x49 frequency coordinate model. All arithmetic follows the binary in float32 order.
// Tested against the installed binary by analysis/port/compare-analysis.mjs.
import {KERNEL_HALF,BIN_COUNT,POWER_COUNT,WINDOW,KERNEL,BIN_WEIGHTS,POWER_WEIGHTS} from './visco-tables.js';
import {constrainCurve,normalization} from './morph-core.js';
import {fft256} from './fft.js';

const f=Math.fround;
const RATE=44100,HOP=64,SIZE=256,BINS=129,BANDS=80,FRAMES=96;
const sqrt=x=>f(Math.sqrt(x)),logf=x=>f(Math.log(x)),expf=x=>f(Math.exp(x)),powf=(a,b)=>f(Math.pow(a,b));
const POW=powf(f(1.04),-25),LOG104=logf(f(1.04));
// Linear model time below 25 frames, logarithmic above (0x751f0 and its inverse 0x75180).
export const toModelTime=x=>{x=f(x);return x<25?x:f(logf(f(x/f(POW*25)))/LOG104);};
export const fromModelTime=x=>{x=f(x);return x<25?x:f(expf(f(LOG104*x))*f(POW*25));};

// Catmull-Rom read used by the 44.1 kHz conversion (0x68430).
function cubic(s,n,i,x){
 const c=[0,f(f(f(f(1-f(x*.5))*x)-.5)*x),f(f(f(f(f(x*1.5)-2.5)*x)*x)+1),f(f(f(f(2-f(x*1.5))*x)+.5)*x),f(f(f(f(x*.5)-.5)*x)*x)];
 const lo=Math.max(0,1-i),hi=Math.min(4,n-i-3);let sum=0;
 for(let k=lo;k<hi;k++)sum=f(sum+f(s[i-1+k]*c[k+1]));
 return sum;
}
// One-pole high-pass set up by 0x53fc0 and run by 0x53900.
function highPass(s){
 const q=f(.1),w=f(f(f(.0031746032182127237)*f(-Math.PI))/sqrt(q)),wq=f(w*q);
 const pole=x=>f(f(f(f(1/f(f(1-f(x*.75))+f(f(x*.375)*x)))-1)*1.25)+1);
 const p1=pole(w),p2=pole(wq),a0=f(-p1),a1=f(f(f(1-p1)*q)/f(1-p2)),a2=f(f(-p2)*a1);
 let state=0;
 for(let i=0;i<s.length;i++){const v=f(s[i]-f(state*a0));s[i]=f(f(state*a2)+f(v*a1));state=v;}
}
// Bidirectional one-pole smoothing (0x70e60).
function smooth(x,c){
 const a=f(1-c),n=x.length,y=new Float32Array(n);let v=x[0];
 for(let i=0;i<n;i++){v=f(f(f(x[i]-v)*a)+v);y[i]=v;}
 for(let i=n-2;i>=0;i--){v=f(v+f(f(y[i]-v)*a));y[i]=v;}
 return y;
}
// Spectral gate (0x73f30). It changes power in place and returns the per-bin gain.
function gate(p,complex){
 const a=smooth(p,f(.73)),b=smooth(p,f(.95));
 for(let k=0;k<p.length;k++){
  const v=p[k];let d=f(v-f(f(a[k]*f(.0020000000949949026))+f(b[k]*f(5.000000058430487e-8))));if(d<=0)d=0;
  const g=f(f(d*d)/f(f(v*v)+f(1.0000000180025095e-35)));p[k]=f(f(g*g)*v);
  if(complex){complex[2*k]=f(g*complex[2*k]);complex[2*k+1]=f(g*complex[2*k+1]);}
 }
}
const fft=fft256;
// Tridiagonal smoothing solve used by the factorization (0x700e0).
function solve(m,w,x,alongFrequency){
 const rows=m.length,cols=m[0].length,t=w.map(r=>Float32Array.from(r));
 if(alongFrequency){
  for(let r=0;r<rows;r++)x[r][0]=m[r][0];
  for(let c=1;c<cols;c++)for(let r=0;r<rows;r++){const k=f(1/f(t[r][c-1]+1));x[r][c]=f(f(k*x[r][c-1])+m[r][c]);t[r][c]=f(f(k*t[r][c-1])+t[r][c]);}
  for(let r=0;r<rows;r++)x[r][cols-1]=f(x[r][cols-1]/f(t[r][cols-1]+f(1e-30)));
  for(let c=cols-2;c>=0;c--)for(let r=0;r<rows;r++)x[r][c]=f(f(x[r][c+1]+x[r][c])/f(t[r][c]+1));
 }else{
  x[0].set(m[0]);
  for(let r=1;r<rows;r++)for(let c=0;c<cols;c++){const k=f(1/f(t[r-1][c]+1));x[r][c]=f(f(k*x[r-1][c])+m[r][c]);t[r][c]=f(f(k*t[r-1][c])+t[r][c]);}
  for(let c=0;c<cols;c++)x[rows-1][c]=f(x[rows-1][c]/f(t[rows-1][c]+f(1e-30)));
  for(let r=rows-2;r>=0;r--)for(let c=0;c<cols;c++)x[r][c]=f(f(x[r+1][c]+x[r][c])/f(t[r][c]+1));
 }
}
const columnSums=m=>{const s=new Float32Array(m[0].length);for(const r of m)for(let c=0;c<s.length;c++)s[c]=f(s[c]+r[c]);return s;};
const rowSums=m=>Float32Array.from(m,r=>{let s=0;for(const v of r)s=f(s+v);return s;});
const total=a=>{let s=0;for(const v of a)s=f(s+v);return s;};
const scale=(m,k)=>{for(const r of m)for(let c=0;c<r.length;c++)r[c]=f(k*r[c]);};
// Smooth rank-one factorization of the 96x80 matrix into time and spectrum fields (0x6ed60).
function factorize(m,lambda){
 const rows=m.length,cols=m[0].length,cs=columnSums(m),rs=rowSums(m),sum=total(cs);
 let g=f(1/sqrt(sum));const s=f(f(f(f(rows)*lambda)*f(cols))/sum);scale(m,s);g=f(g*s);
 const T=Array.from({length:rows},(_,r)=>new Float32Array(cols).fill(f(g*rs[r])));
 const F=Array.from({length:rows},()=>Float32Array.from(cs,v=>f(g*v)));
 const history=[];
 for(let k=0;k<20;k++){
  solve(m,F,T,true);
  const tc=columnSums(T),tm=f(total(tc)/cols);
  for(const r of T)for(let c=0;c<cols;c++)r[c]=f(f(f(f(tc[c]*f(.1))+tm)/f(tc[c]*f(1.1)))*r[c]);
  solve(m,T,F,false);
  const fr=rowSums(F),fm=f(total(fr)/rows);
  for(let r=0;r<rows;r++){const k2=f(f(f(fr[r]*f(.1))+fm)/f(fr[r]*f(1.1)));for(let c=0;c<cols;c++)F[r][c]=f(k2*F[r][c]);}
  let fit=0,tSmooth=0,fSmooth=0;
  for(let r=0;r<rows;r++)for(let c=0;c<cols;c++){
   const e=f(m[r][c]-f(F[r][c]*T[r][c]));fit=f(fit+f(e*e));
   if(r){const d=f(T[r][c]-T[r-1][c]);tSmooth=f(tSmooth+f(f(d*d)*lambda));}
   if(c){const d=f(F[r][c]-F[r][c-1]);fSmooth=f(fSmooth+f(f(d*d)*lambda));}
  }
  const ratio=sqrt(f(f(fSmooth+f(1e-30))/f(tSmooth+f(1e-30)))),q=sqrt(ratio);
  scale(T,q);scale(F,f(1/q));
  history[k]=f(f(f(ratio*tSmooth)+fit)+f(fSmooth/ratio));
  if(k>=4&&!(history[k]<=f(history[k-2]*f(.9998999834060669))))break;
 }
 const inv=f(1/s);scale(m,inv);const r=sqrt(inv);scale(T,r);scale(F,r);
 return {T,F};
}
// Equal-energy landmarks with a smoothed cumulative curve (0xd0a60, last argument 0).
export function quantiles(v,count){
 const n=v.length,out=new Float32Array(count),step=f(total(v)/f(count-1));
 let x19=v[0],x17=0,cum=0,target=0,x22=0,x21=0,index=-1,x18=x19,x27=0,j=-1;
 out[count-1]=n;
 for(let q=0;q<count-1;q++){
  if(cum<=target){
   let x14=x22,i9=index;
   for(;;){
    const x25=cum,x23=x19;x22=x14;index=i9;
    if(n-1<=i9)break;
    let a=v[++j];index=i9+1;cum=f(x25+a);
    const b=v[Math.min(i9+2,n-1)],c=v[Math.min(i9+3,n-1)],d=v[Math.max(i9,0)];
    let lo=a<=b?a:b;
    a=f(f(f(a+b)*f(.6000000238418579))-f(f(c+d)*f(.1)));
    x19=a<=f(lo+lo)?a:f(lo+lo);
    x22=f(b-x19);
    x21=f(f(f(x19-x23)-f(x14+x14))/f(f(x14+x23)+f(1e-30)));
    x17=x14;x14=x22;x18=x23;x27=x25;i9=index;
    if(!(cum<=target))break;
   }
  }
  const d=f(target-x27);
  const r=sqrt(f(f(f(f(f(f(f(x21+4)*d)-f(x18+x18))*x21)+f(x17*4))*d)+f(x18*x18)));
  target=f(target+step);
  out[q]=f(f(f(d+d)/f(f(f(r+x18)-f(d*x21))+f(1e-30)))+index);
 }
 // Gentle spacing correction of interior landmarks.
 let prev=out[0];
 const fix=(a,u,d)=>f(a-f(f(f(f(u-.5)*f(u*f(20.780000686645508)))*f(u-1))*f(d*f(.03999999910593033))));
 for(let i=1;i<count-1;i++){
  const a=out[i],d=f(out[i+1]-prev),u=f(f(a-prev)/d);
  out[i]=fix(a,u,d);prev=a;
 }
 return out;
}
const lerp=(v,x)=>{const k=x|0;return f(f(f(v[k+1]-v[k])*f(x-k))+v[k]);};
const transpose=m=>Array.from(m[0],(_,c)=>Float32Array.from(m,r=>r[c]));
// Coupled time and frequency landmark grid (0xd04b0).
function landmarkGrid(T,F){
 const bandTimes=transpose(T).map(col=>quantiles(col,41)),frameFreqs=F.map(row=>quantiles(row,49));
 const timeByLandmark=transpose(bandTimes),freqByLandmark=transpose(frameFreqs);
 const P=Array.from({length:41},()=>new Float32Array(49)),Q=Array.from({length:41},()=>new Float32Array(49));
 const step=f(80/f(49.5)),xMax=f(80-f(1.000100016593933)),yMax=f(96-f(1.000100016593933));
 for(let i=0;i<41;i++)for(let q=0;q<49;q++){
  let guess=q?f(step+Q[i][q-1]):0,time=0,freq=0;
  for(let n=0;;){
   let x=guess<xMax?guess:xMax;if(x<=0)x=0;time=lerp(timeByLandmark[i],x);
   let y=time<yMax?time:yMax;if(y<=0)y=0;freq=lerp(freqByLandmark[q],y);
   if(!(f(.0010000000474974513)<=Math.abs(f(guess-freq)))||++n>=10)break;
   guess=freq;
  }
  P[i][q]=time;Q[i][q]=freq;
 }
 return {P,Q};
}
// Weighted reduction of landmarks to coarse knots with a smoothed residual fit (0x75260).
function reduce(x,w,K,lambda){
 const n=x.length,M=Math.floor((n-1+K)/K),base=new Float32Array(M);
 for(let k=0;k<M;k++){
  let s=0,ws=f(1e-30);const a=Math.max(0,k*K-K+1),b=Math.min(n,k*K+K);
  for(let j=a;j<b;j++){const t=f(f(1-Math.abs(f(k-f(j/K))))*w[j]);s=f(s+f(t*x[j]));ws=f(ws+t);}
  base[k]=f(s/ws);
 }
 const diag=new Float32Array(M).fill(f(1e-30)),off=new Float32Array(M-1),rhs=new Float32Array(M);
 for(let j=0;j<n;j++){
  const k=Math.min(Math.trunc(f(j/K)),M-2),t=f(f(j/K)-k),u=f(1-t),r=f(x[j]-f(f(f(base[k+1]-base[k])*t)+base[k]));
  diag[k]=f(f(f(u*u)*w[j])+diag[k]);diag[k+1]=f(f(f(t*t)*w[j])+diag[k+1]);off[k]=f(f(f(t*u)*w[j])+off[k]);
  rhs[k]=f(f(f(u*w[j])*r)+rhs[k]);rhs[k+1]=f(f(f(t*w[j])*r)+rhs[k+1]);
 }
 for(let k=0;k<M;k++)diag[k]=f(diag[k]*f(lambda+1));
 for(let k=1;k<M;k++){diag[k]=f(diag[k]-f(f(off[k-1]*off[k-1])/diag[k-1]));rhs[k]=f(rhs[k]-f(f(rhs[k-1]*off[k-1])/diag[k-1]));}
 const out=new Float32Array(M);out[M-1]=f(rhs[M-1]/diag[M-1]);
 for(let k=M-2;k>=0;k--)out[k]=f(f(rhs[k]-f(off[k]*out[k+1]))/diag[k]);
 for(let k=0;k<M;k++)out[k]=f(base[k]+out[k]);
 return out;
}
// Minimum-spacing repair (0x710a0).
function spread(p,gap){
 const n=p.length,c=Float32Array.from(p);
 for(let i=1;i<n;i++){const v=f(gap+c[i-1]);c[i]=v<=p[i]?p[i]:v;}
 let v=p[n-1];
 for(let i=n-2;i>=0;i--){const lim=f(v-gap);v=p[i]<=lim?p[i]:lim;p[i]=f(f(v+c[i])*.5);}
}
const minGap=rows=>{let g=f(1e30);for(let i=1;i<rows.length;i++)for(let k=0;k<rows[i].length;k++){const d=f(rows[i][k]-rows[i-1][k]);if(d<=g)g=d;}return g;};

// Visco's import: samples at any rate in, model coordinates out. Returns null for silent input.
export function analyze(input,sampleRate,trace=null){
 const sr=f(sampleRate),n0=input.length;let sum=0,peak=0,i=0;
 for(;i<n0;i++){if(f(1e-20)<=sum)break;const a=Math.abs(input[i]);sum=f(sum+a);if(a>peak)peak=a;}
 if(i===n0&&sum<f(1e-20))return null;
 const thr=f(peak*f(.0001));let start=0,end=n0;
 while(start<n0&&!(thr<=Math.abs(input[start])))start++;
 if(start>=n0)return null;
 while(end>start&&!(thr<=Math.abs(input[end-1])))end--;
 if(end<=start)return null;
 const length=Math.max(Math.trunc(f(sr*f(.1))),end+Math.trunc(f(f(sr*256)/RATE))-start);
 let s=new Float32Array(length);s.set(input.subarray?input.subarray(start,end):input.slice(start,end));
 if(trace)trace.padded=Float32Array.from(s);
 if(f(.1)<Math.abs(f(sr-RATE))){
  const ratio=f(sr/RATE),count=Math.trunc(length/ratio),r=new Float32Array(count);
  for(let k=0;k<count;k++){const x=k*ratio,j=Math.trunc(x);r[k]=cubic(s,length,j,f(x-j));}
  s=r;
 }
 if(trace)trace.resampled=Float32Array.from(s);
 highPass(s);
 if(trace)trace.filtered=Float32Array.from(s);
 const N=s.length,frames=Math.trunc((N+SIZE)/HOP),spectra=[],powers=[],frame=new Float32Array(SIZE);
 for(let t=0;t<frames;t++){
  frame.fill(0);const offset=t*HOP-192,lo=Math.max(0,-offset),hi=Math.min(SIZE,N-offset);
  for(let k=lo;k<hi;k++)frame[(k+128)&255]=f(s[offset+k]*WINDOW[k]);
  const c=new Float32Array(2*BINS);if(trace?.frames)trace.frames.push(Float32Array.from(frame));if(trace?.fftOverride){const o=trace.fftOverride[t];c[0]=o[0];c[1]=0;c.set(o.subarray(2,256),2);c[256]=o[1];c[257]=0;}else fft(frame,c);
  if(trace?.complexOverride)c.set(trace.complexOverride[t]);
  const p=new Float32Array(BINS);for(let k=0;k<BINS;k++)p[k]=f(f(c[2*k]*c[2*k])+f(c[2*k+1]*c[2*k+1]));
  if(trace)(trace.powerPre??=[]).push(Float32Array.from(p));
  gate(p,c);spectra.push(c);powers.push(p);
 }
 const energy=Array.from({length:frames},()=>new Float32Array(BANDS));
 const yr=new Float32Array(frames),yi=new Float32Array(frames);
 for(let b=0,kOff=0,wOff=0,pOff=0;b<BANDS;b++){
  const K=KERNEL_HALF[b],L=2*K-1,kr=new Float32Array(L),ki=new Float32Array(L);
  for(let j=0;j<K;j++){kr[K-1-j]=KERNEL[2*(kOff+j)];ki[K-1-j]=KERNEL[2*(kOff+j)+1];kr[K-1+j]=KERNEL[2*(kOff+j)];ki[K-1+j]=f(-KERNEL[2*(kOff+j)+1]);}
  const bin=BIN_WEIGHTS[wOff]|0,nb=BIN_COUNT[b]-1;
  for(let t=0;t<frames;t++){let a=0,c=0;const S=spectra[t];
   for(let k=0;k<nb;k++){const w=BIN_WEIGHTS[wOff+1+k];a=f(f(w*S[2*(bin+k)])+a);c=f(f(w*S[2*(bin+k)+1])+c);}
   yr[t]=a;yi[t]=c;}
  const np=POWER_COUNT[b];
  for(let t=0;t<frames;t++){
   let re=0,im=0;const m0=Math.max(K-1-t,0),m1=Math.min(frames+K-1-t,L);
   for(let m=m0;m<m1;m++){const u=t-(K-1)+m;re=f(re+f(f(kr[m]*yr[u])-f(ki[m]*yi[u])));im=f(im+f(f(kr[m]*yi[u])+f(ki[m]*yr[u])));}
   let e=f(f(im*im)+f(re*re));
   if(np>0){const p=powers[t],first=POWER_WEIGHTS[pOff]|0;let d=0;
    for(let k=0;k<np-2;k++)d=f(d+f(p[first+k]*POWER_WEIGHTS[pOff+2+k]));
    e=f(d+f(e*POWER_WEIGHTS[pOff+1]));}
   energy[t][b]=e;
  }
  kOff+=K;wOff+=BIN_COUNT[b];pOff+=np;
 }
 if(trace)trace.energy0=energy.map(r=>Float32Array.from(r));
 for(const e of energy)gate(e,null);
 if(trace)trace.energy=energy;
 const grid=Array.from({length:FRAMES},()=>new Float32Array(BANDS));
 for(let t=0;t<FRAMES;t++){
  const lo=Math.trunc(f(fromModelTime(f(t-1))+1)),hi=Math.min(Math.trunc(f(fromModelTime(f(t+1))+1)),frames);
  if(f(hi)<f(f(lo)*f(1.0199999809265137)))break;
  const acc=new Float32Array(BANDS);let ws=f(1e-30);
  for(let j=lo;j<hi;j++){const d=Math.abs(f(toModelTime(j)-t)),w=f(1-f(f(f(3-f(d+d))*d)*d));ws=f(ws+w);
   for(let b=0;b<BANDS;b++)acc[b]=f(f(w*energy[j][b])+acc[b]);}
  for(let b=0;b<BANDS;b++)grid[t][b]=sqrt(sqrt(f(acc[b]/ws)));
 }
 if(trace?.gridOverride)for(let i=0;i<FRAMES;i++)grid[i].set(trace.gridOverride[i]);
 if(trace)trace.grid=grid.map(r=>Float32Array.from(r));
 const {T,F}=factorize(grid,f(.004999999888241291));
 if(trace){trace.T=T.map(r=>Float32Array.from(r));trace.F=F.map(r=>Float32Array.from(r));}
 let tSum=0,fSum=0;for(let row=0;row<T.length;row++)for(let b=0;b<BANDS;b++){tSum=f(tSum+T[row][b]);fSum=f(fSum+F[row][b]);}
 const tMean=f(tSum/f(T.length*BANDS)),fMean=f(fSum/f(F.length*BANDS));
 const tm=f(tMean*f(.699999988079071)),fm=f(fMean*f(.699999988079071));
 for(const r of T)for(let c=0;c<BANDS;c++)r[c]=f(tm+r[c]);
 for(const r of F)for(let c=0;c<BANDS;c++)r[c]=f(fm+r[c]);
 if(trace){trace.T2=T.map(r=>Float32Array.from(r));trace.F2=F.map(r=>Float32Array.from(r));}
 const {P,Q}=trace?.landmarkOverride??landmarkGrid(T,F),D=Array.from({length:41},()=>new Float32Array(49));
 for(let i=0;i<41;i++){const i0=Math.max(i-1,0),i1=Math.min(i+1,40);
  for(let q=0;q<49;q++){const q0=Math.max(q-1,0),q1=Math.min(q+1,48);
   D[i][q]=f(f((q1-q0)*(i1-i0))/f(f(Q[i][q1]-Q[i][q0])*f(P[i1][q]-P[i0][q])));}}
 if(trace)Object.assign(trace,{P,Q,D});
 const lambda=f(.33000001311302185);
 const time=transpose(P.map((row,i)=>reduce(row,D[i],8,lambda))).map(r=>Array.from(r));
 const Qt=transpose(Q),Dt=transpose(D);
 const frequency=transpose(Qt.map((row,q)=>reduce(row,Dt[q],8,lambda))).map(r=>Array.from(r));
 const tg=f(minGap(P)*f(.8999999761581421)),fg=f(minGap(Qt)*f(.8999999761581421));
 if(trace)Object.assign(trace,{time0:time.map(r=>r.slice()),freq0:frequency.map(r=>r.slice()),tg,fg});
 for(const c of time)spread(c,tg);
 for(const c of frequency)spread(c,fg);
 for(const c of time)constrainCurve(c,96);
 for(const c of frequency)constrainCurve(c,80);
 const m={version:1,name:'Imported sound',time,frequency};m.norm=normalization(m);
 return m;
}
// Blob writer with Visco's error-feedback rounding (0x73be0).
export function encodeViscoBlob(m){
 const bytes=new Uint8Array(1137),v=new DataView(bytes.buffer);bytes[0]=1;let o=1;
 for(const row of [...m.time,...m.frequency]){let acc=0;
  for(let i=1;i<row.length;i++,o+=2){const s=Math.trunc(f(f(f(f(row[i])-f(f(acc)*f(.0009765774011611938)))*f(1023.984375))+.5));acc+=s;v.setUint16(o,s&65535,true);}}
 return bytes;
}
// WAV reader matching Visco's loader: channels are averaged to mono in float32.
export function decodeWav(buffer){
 const v=new DataView(buffer.buffer||buffer,buffer.byteOffset||0,buffer.byteLength),tag=o=>String.fromCharCode(v.getUint8(o),v.getUint8(o+1),v.getUint8(o+2),v.getUint8(o+3));
 if(v.byteLength<12||tag(0)!=='RIFF'||tag(8)!=='WAVE')throw Error('Choose a RIFF WAV file.');
 let fmt=null,data=null;
 for(let o=12;o+8<=v.byteLength;){const id=tag(o),size=v.getUint32(o+4,true),body=o+8;
  if(id==='fmt ')fmt={format:v.getUint16(body,true),channels:v.getUint16(body+2,true),rate:v.getUint32(body+4,true),bits:v.getUint16(body+14,true),ext:size>=40?v.getUint16(body+24,true):0};
  else if(id==='data')data={offset:body,size:Math.min(size,v.byteLength-body)};
  o=body+size+(size&1);}
 if(!fmt||!data)throw Error('The WAV file has no format or data chunk.');
 const format=fmt.format===0xfffe?fmt.ext:fmt.format,ch=fmt.channels,bytes=fmt.bits/8,frames=Math.floor(data.size/(bytes*ch));
 if(!ch||!(format===1&&[8,16,24,32].includes(fmt.bits))&&!(format===3&&[32,64].includes(fmt.bits)))throw Error('Use 8, 16, 24, or 32-bit PCM, or float WAV data.');
 const read=o=>{
  if(format===3)return fmt.bits===32?v.getFloat32(o,true):f(v.getFloat64(o,true));
  switch(fmt.bits){
   case 8:return f(f(v.getUint8(o)*f(.00784313725490196078))-1);
   case 16:return f(v.getInt16(o,true)*f(.000030517578125));
   case 24:{const x=(v.getUint8(o)|v.getUint8(o+1)<<8|v.getInt8(o+2)<<16);return f(x*.00000011920928955078125);}
   default:return f(v.getInt32(o,true)/2147483648);
  }};
 const out=new Float32Array(frames),c=f(ch);
 for(let i=0,o=data.offset;i<frames;i++){let s=0;for(let k=0;k<ch;k++,o+=bytes)s=f(s+read(o));out[i]=ch>1?f(s/c):s;}
 return {samples:out,sampleRate:fmt.rate};
}
