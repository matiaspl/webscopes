import {analyzeFrame,createScopes,renderScopes} from '../../src/index.js';
const out=[];
const emit=(name,value)=>{out.push({name,...value});document.querySelector('#status').textContent=JSON.stringify(out,null,2)};
const sum=a=>a.reduce((x,y)=>x+y,0);
const differences=(a,b)=>a.reduce((n,v,i)=>n+(v!==b[i]),0);
const compare=(a,b)=>({waveDiffs:a.waveform.channels.map((c,i)=>differences(c,b.waveform.channels[i])),vectorDiffs:differences(a.vectorscope.bins,b.vectorscope.bins),cpuSums:a.waveform.channels.map(sum),gpuSums:b.waveform.channels.map(sum)});
const source=(w,h,pixel)=>{
 const canvas=document.createElement('canvas');canvas.width=w;canvas.height=h;
 const context=canvas.getContext('2d',{willReadFrequently:true});const image=context.createImageData(w,h);
 for(let y=0;y<h;y++)for(let x=0;x<w;x++)image.data.set([...pixel(x,y),255],(y*w+x)*4);
 context.putImageData(image,0,0);return {canvas,image};
};
try{
 emit('environment',{ua:navigator.userAgent,gpu:Boolean(navigator.gpu)});
 const device=await (await navigator.gpu.requestAdapter()).requestDevice();
 const scopes=await createScopes({backend:'webgpu',device,autoRender:false});
 const fixtures=[
  ['sampling-half-tie',source(6,1,x=>x===2?[255,0,0]:[0,0,0]),{inputResolutionScaling:.5,waveformWidth:3}],
  ['ycbcr-neutral-tie',source(1,1,()=>[128,128,128]),{waveformMode:'ycbcr-parade',waveformHeight:18}],
  ['bt601-luma',source(256,1,x=>[x,255-x,(x*19)%256]),{waveformMode:'luma',colorMatrix:'bt601'}],
  ['bt709-ycbcr',source(256,256,(x,y)=>[x,y,(x+y)%256]),{waveformMode:'ycbcr-parade'}],
 ];
 for(const [name,s,options] of fixtures){const cpu=analyzeFrame(s.image,options);const gpu=await scopes.update(s.canvas,options);emit(name,compare(cpu,gpu));}
 const context=document.createElement('canvas').getContext('2d');context.fillStyle='#123456';context.fillStyle=[255,62,72];emit('array-fill-style',{actual:context.fillStyle});
 const auto=await createScopes({backend:'auto',device,autoRender:false});
 try{await auto.update(source(1,1,()=>[0,0,0]).canvas,{region:{x:1,y:0,width:.001,height:1}})}catch(e){emit('invalid-roi-demotes-gpu',{backend:auto.backend,error:e.message})}
 auto.destroy(); scopes.destroy();device.destroy();
 emit('complete',{});
}catch(e){emit('error',{message:e.stack})}
