import { analyzeFrame, renderScopes } from '../../src/index.js';
const width=1920,height=1080;
const data=new Uint8Array(width*height*4);
for(let i=0;i<data.length;i+=4){data[i]=(i/4)%256;data[i+1]=(i/1024)%256;data[i+2]=(i/256)%256;data[i+3]=255}
const context={canvas:{width:960,height:520},createImageData(w,h){return{width:w,height:h,data:new Uint8ClampedArray(w*h*4)}},putImageData(){},fillRect(){},save(){},restore(){},setLineDash(){},beginPath(){},moveTo(){},lineTo(){},stroke(){},fillText(){},arc(){},fill(){}};
const mean=a=>a.reduce((x,y)=>x+y)/a.length;
for(const mode of ['rgb-parade','luma']){
 const times=[],draws=[];let result;
 for(let i=0;i<8;i++){let t=performance.now();result=analyzeFrame({width,height,data},{waveformMode:mode});let e=performance.now();renderScopes(result,context,{devicePixelRatio:1});let f=performance.now();if(i>=3){times.push(e-t);draws.push(f-e)}}
 console.log(JSON.stringify({mode,input:[width,height],canvas:[960,520],cpuMs:mean(times),renderJsMs:mean(draws),cpuHistogramBytes:result.waveform.channels.reduce((n,c)=>n+c.byteLength,0)+result.vectorscope.bins.byteLength}));
}
