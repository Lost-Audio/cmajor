// 256-point real FFT. The arithmetic order follows PFFFT's four-lane radix-4 path.
// Derived from PFFFT/FFTPACK. See FFT-LICENSE.txt for the original notices.
import {FFT_E,FFT_W} from './fft-tables.js';
const f=Math.fround,A=(a,b)=>f(a+b),S=(a,b)=>f(a-b),M=(a,b)=>f(a*b);
const add=(a,b)=>a.map((x,i)=>A(x,b[i])),sub=(a,b)=>a.map((x,i)=>S(x,b[i]));
const v=(a,i)=>Array.from(a.subarray(i*4,i*4+4)),put=(a,i,x)=>a.set(x,i*4);
const cmul=(ar,ai,br,bi)=>[ar.map((x,i)=>S(M(x,br[i]),M(ai[i],bi[i]))),ar.map((x,i)=>A(M(x,bi[i]),M(ai[i],br[i])))];
const transpose=rows=>rows[0].map((_,i)=>rows.map(r=>r[i]));
function radix4(ido,l1,cc,ch,iw){
 const l=l1*ido,h=f(-Math.SQRT1_2);
 for(let lane=0;lane<4;lane++){
  const get=i=>cc[i*4+lane],set=(i,x)=>{ch[i*4+lane]=x;};
  for(let k=0;k<l;k+=ido){const a0=get(k),a1=get(k+l),a2=get(k+2*l),a3=get(k+3*l),tr1=A(a1,a3),tr2=A(a0,a2);
   set(4*k+2*ido-1,S(a0,a2));set(4*k+2*ido,S(a3,a1));set(4*k,A(tr1,tr2));set(4*k+4*ido-1,S(tr2,tr1));}
  if(ido<2)continue;
  if(ido!==2)for(let k=0;k<l;k+=ido)for(let i=2;i<ido;i+=2){const ic=ido-i,pc=1+k+i-2;
   const mul=(q,w)=>{const r=get(pc+q*l),im=get(pc+q*l+1),wr=FFT_W[w+i-2],wi=FFT_W[w+i-1];return[A(M(r,wr),M(im,wi)),S(M(im,wr),M(r,wi))];};
   const[cr2,ci2]=mul(1,iw),[cr3,ci3]=mul(2,iw+ido),[cr4,ci4]=mul(3,iw+2*ido);
   const tr1=A(cr2,cr4),tr4=S(cr4,cr2),tr2=A(get(pc),cr3),tr3=S(get(pc),cr3);
   set(i-1+4*k,A(tr1,tr2));set(ic-1+4*k+3*ido,S(tr2,tr1));
   const ti1=A(ci2,ci4),ti4=S(ci2,ci4);set(i-1+4*k+2*ido,A(ti4,tr3));set(ic-1+4*k+ido,S(tr3,ti4));
   const ti2=A(get(pc+1),ci3),ti3=S(get(pc+1),ci3);set(i+4*k,A(ti1,ti2));set(ic+4*k+3*ido,S(ti1,ti2));set(i+4*k+2*ido,A(tr4,ti3));set(ic+4*k+ido,S(tr4,ti3));
  }
  if(ido%2)continue;
  for(let k=0;k<l;k+=ido){const a=get(ido-1+k+l),b=get(ido-1+k+3*l),c=get(ido-1+k),d=get(ido-1+k+2*l),ti1=M(h,A(a,b)),tr1=M(h,S(b,a));
   set(ido-1+4*k,A(tr1,c));set(ido-1+4*k+2*ido,S(c,tr1));set(4*k+ido,S(ti1,d));set(4*k+3*ido,A(ti1,d));}
 }
}
const e=Float32Array.from(FFT_E),work1=new Float32Array(256),work2=new Float32Array(256),final=new Float32Array(256),packed=new Float32Array(256);
function finalize(src){
 for(let k=0;k<8;k++){
  const r=transpose([k?v(src,k*8-1):[0,0,0,0],v(src,k*8+1),v(src,k*8+3),v(src,k*8+5)]);
  const im=transpose([k?v(src,k*8):[0,0,0,0],v(src,k*8+2),v(src,k*8+4),v(src,k*8+6)]);
  for(let j=1;j<4;j++)[r[j],im[j]]=cmul(r[j],im[j],v(e,k*6+(j-1)*2),v(e,k*6+(j-1)*2+1));
  const sr0=add(r[0],r[2]),dr0=sub(r[0],r[2]),sr1=add(r[1],r[3]),dr1=sub(r[3],r[1]),si0=add(im[0],im[2]),di0=sub(im[0],im[2]),si1=add(im[1],im[3]),di1=sub(im[3],im[1]);
  [add(sr0,sr1),add(si0,si1),add(dr0,di1),sub(dr1,di0),sub(dr0,di1),add(dr1,di0),sub(sr0,sr1),sub(si1,si0)].forEach((x,i)=>put(final,8*k+i,x));
 }
 const cr=v(src,0),ci=v(src,63),s=f(Math.SQRT1_2);
 final[0]=A(A(cr[0],cr[2]),A(cr[1],cr[3]));final[4]=S(A(cr[0],cr[2]),A(cr[1],cr[3]));
 final[16]=S(cr[0],cr[2]);final[20]=S(cr[3],cr[1]);
 final[8]=A(ci[0],M(s,S(ci[1],ci[3])));final[12]=S(-ci[2],M(s,A(ci[1],ci[3])));
 final[24]=S(ci[0],M(s,S(ci[1],ci[3])));final[28]=S(ci[2],M(s,A(ci[1],ci[3])));
}
const interleave=(a,b)=>[[a[0],b[0],a[1],b[1]],[a[2],b[2],a[3],b[3]]],swap=(a,b)=>[b[0],b[1],a[2],a[3]];
function reorder(){
 for(let k=0;k<8;k++)for(const q of [0,2]){const [a,b]=interleave(v(final,k*8+q*2),v(final,k*8+q*2+1));put(packed,2*(q*8+k),a);put(packed,2*(q*8+k)+1,b);}
 for(const base of [2,6]){let out=base===2?32:64;const[g0,gStart]=interleave(v(final,base),v(final,base+1));let g1=gStart;put(packed,--out,swap(g0,g1));
  for(let k=1;k<8;k++){const[h0,h1]=interleave(v(final,base+k*8),v(final,base+k*8+1));put(packed,--out,swap(g1,h0));put(packed,--out,swap(h0,h1));g1=h1;}
  put(packed,--out,swap(g1,g0));
 }
}
export function fft256(input,out){
 radix4(1,16,input,work1,60);radix4(4,4,work1,work2,48);radix4(16,1,work2,work1,0);finalize(work1);reorder();
 out[0]=packed[0];out[1]=0;out.set(packed.subarray(2),2);out[256]=packed[1];out[257]=0;
}
