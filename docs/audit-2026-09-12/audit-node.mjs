import { analyzeFrame, renderScopes, createScopes, getDefaultScopesConfig } from '../../src/index.js';
import { createWebGpuAnalyzer } from '../../src/webgpu.js';

const sum = a => a.reduce((a,b) => a+b, 0);
const raw = { width: 1, height: 2, data: new Uint8Array([255,0,0,255,0,255,0,255]) };
const summarize = r => ({ samples:r.sampleCount, waveSums:r.waveform.channels.map(sum), vectorSum:sum(r.vectorscope.bins) });
const report = (name, value) => console.log(JSON.stringify({name, ...value}));
const highBitFrame = {width:1,height:1,bitDepth:10,data:new Uint16Array([512,512,512,1023])};
for (const [label, config] of [['implicit', {backend:'cpu'}], ['helper', {...getDefaultScopesConfig(),backend:'cpu'}]]) {
  const scopes=await createScopes(config);
  const result=await scopes.update(highBitFrame);
  const peak=result.waveform.channels[0].findIndex(v=>v);
  report('default-precision-'+label,{bitDepth:result.waveform.bitDepth,levels:result.waveform.height,peakRow:Math.floor(peak/result.waveform.width)});
  scopes.destroy();
}
for (const [name, input, options] of [
  ['truncated-padded-rows', {...raw, bytesPerRow:8}, {}],
  ['fractional-pixel-stride', {...raw, width:2, height:1, data:new Uint8Array(16), pixelStride:4.5, bytesPerRow:16}, {}],
  ['nan-pixel-stride', {...raw, pixelStride:NaN}, {}],
  ['nan-float-sample', {width:1,height:1,data:new Float32Array([NaN,0,0,1])}, {}],
  ['prototype-matrix', raw, {colorMatrix:'toString', waveformMode:'luma'}],
]) {
  try { report(name, {accepted:true, ...summarize(analyzeFrame(input, options))}); }
  catch(e) { report(name, {accepted:false,error:e.message}); }
}

function recordingContext(width,height) {
  const images=[], arcs=[], texts=[];
  return {images,arcs,texts,canvas:{width,height},
    createImageData(width,height){return {width,height,data:new Uint8ClampedArray(width*height*4)}},
    putImageData(image,x,y){images.push({image,x,y})},
    arc(...args){arcs.push(args)}, fillText(...args){texts.push(args)},
    fillRect(){},save(){},restore(){},setLineDash(){},beginPath(){},moveTo(){},lineTo(){},stroke(){},fill(){}
  };
}
const red = analyzeFrame({width:1,height:1,data:new Uint8Array([255,0,0,255])});
let context = recordingContext(960,540);
renderScopes(red,context,{dither:0,devicePixelRatio:1,showPerformance:false});
let raster=context.images[1];
let lit=[];
for(let y=0;y<raster.image.height;y++) for(let x=0;x<raster.image.width;x++) {
 const i=(y*raster.image.width+x)*4;
 if(raster.image.data[i]!==8 || raster.image.data[i+1]!==13 || raster.image.data[i+2]!==19) lit.push([raster.x+x,raster.y+y]);
}
report('vectorscope-red-target',{rasterSize:raster.image.width,tracePixels:lit,redTarget:context.arcs.find(a=>a[2]===3)});
const gray = analyzeFrame({width:1,height:1,data:new Uint8Array([128,128,128,255])});
context=recordingContext(320,180);
renderScopes(gray,context,{dither:0,devicePixelRatio:1,showPerformance:false});
raster=context.images[1];
let litPixels=0;
for(let i=0;i<raster.image.data.length;i+=4) if(raster.image.data[i]!==8 || raster.image.data[i+1]!==13 || raster.image.data[i+2]!==19) litPixels++;
report('vectorscope-gray-downscale',{rasterSize:raster.image.width,litPixels,vectorSum:sum(gray.vectorscope.bins)});

globalThis.GPUTextureUsage={TEXTURE_BINDING:1,COPY_DST:2,RENDER_ATTACHMENT:4};
globalThis.GPUBufferUsage={STORAGE:1,COPY_SRC:2,COPY_DST:4,MAP_READ:8,UNIFORM:16};
globalThis.GPUMapMode={READ:1};
function fakeDevice({copyThrows=false,mapGate,initializationThrows=false}={}) {
  const state={pushes:0,pops:0,destroyed:0};
  const device={state,limits:{maxTextureDimension2D:8192},queue:{copyExternalImageToTexture(){if(copyThrows)throw new Error('synthetic copy error')},writeBuffer(){},submit(){}},
    createShaderModule(){if(initializationThrows)throw new Error('synthetic initialization error');return{}},
    createComputePipeline(){return {getBindGroupLayout(){return{}}}},
    createTexture(){return{createView(){return{}},destroy(){}}},
    createBuffer({size}){return{destroy(){},async mapAsync(){if(mapGate)await mapGate},getMappedRange(){return new ArrayBuffer(size)},unmap(){}}},
    createBindGroup(){return{}},createCommandEncoder(){return{clearBuffer(){},beginComputePass(){return{setPipeline(){},setBindGroup(){},dispatchWorkgroups(){},end(){}}},copyBufferToBuffer(){},finish(){return{}}}},
    pushErrorScope(){state.pushes++},async popErrorScope(){state.pops++;return null},destroy(){state.destroyed++}
  };
  return device;
}
let device=fakeDevice();
try { const scopes=await createScopes({device,backend:'webgpu'}); scopes.destroy();report('device-only-injection',{accepted:true}); }
catch(e){report('device-only-injection',{accepted:false,error:e.message})}

device=fakeDevice();
let warnings=[];
let scopes=await createScopes({backend:'auto',gpu:{},adapter:{},device,onWarning:m=>warnings.push(m)});
try {await scopes.update({...raw,data:new Uint8Array(1)})}catch{}
report('raw-error-demotes-gpu',{backend:scopes.backend,warnings});scopes.destroy();

device=fakeDevice({copyThrows:true});
let analyzer=await createWebGpuAnalyzer({gpu:{},adapter:{},device});
try {await analyzer.analyze({width:1,height:1})}catch{}
report('copy-error-scope-balance',device.state);analyzer.destroy();

device=fakeDevice({initializationThrows:true});
try {await createWebGpuAnalyzer({gpu:{},adapter:{async requestDevice(){return device}}})}catch{}
report('owned-device-init-failure',device.state);

let releaseMap;
const gate=new Promise(r=>releaseMap=r);
device=fakeDevice({mapGate:gate});
scopes=await createScopes({backend:'webgpu',gpu:{},adapter:{},device});
const pending=scopes.update({width:1,height:1});
await new Promise(r=>setTimeout(r,0));
scopes.destroy(); releaseMap();
let pendingError;
try{await pending}catch(e){pendingError=e.message}
report('destroyed-result-resurrected',{pendingError,resultPresent:scopes.result!==undefined});

let canvasCreations=0;
globalThis.OffscreenCanvas=class {
 constructor(w,h){this.width=w;this.height=h;canvasCreations++}
 getContext(){return{drawImage(){},getImageData:()=>({width:this.width,height:this.height,data:new Uint8ClampedArray(this.width*this.height*4)})}}
};
scopes=await createScopes({backend:'cpu'});
for(let i=0;i<20;i++)await scopes.update({width:8,height:8});
report('cpu-repeated-canvas-allocation',{updates:20,canvasCreations});scopes.destroy();
