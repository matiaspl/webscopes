// Diagnostic only: measure browser video conversions before scope quantization.
const query = new URLSearchParams(location.search);
const status = document.querySelector("#status");
const video = document.querySelector("#video");
const button = document.querySelector("#run");
const isSlate = query.get("slate") === "1";
const srgbDecode = x => x <= 0.04045 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4;
const srgbEncode = x => x <= 0.0031308 ? x * 12.92 : 1.055 * x ** (1 / 2.4) - 0.055;
const bt709Decode = x => x < 0.081 ? x / 4.5 : ((x + 0.099) / 1.099) ** (1 / 0.45);
const bt709Encode = x => x < 0.018 ? x * 4.5 : 1.099 * x ** 0.45 - 0.099;
const clamp = x => Math.min(1, Math.max(0, x));
const round = x => Math.round(x * 10000) / 10000;

async function sampleGpu(device, frame) {
  const w = frame.displayWidth, h = frame.displayHeight;
  const gw = isSlate ? w : Math.min(256, w), gh = isSlate ? h : Math.min(144, h);
  const size = gw * gh * 4 * 16;
  const shader = device.createShaderModule({code: `
    @group(0) @binding(0) var source: texture_external;
    @group(0) @binding(1) var<storage, read_write> result: array<vec4f>;
    @group(0) @binding(2) var nearestSampler: sampler;
    @group(0) @binding(3) var linearSampler: sampler;
    fn undoAppleTransfer(value: vec3f) -> vec3f {
      let c = clamp(value, vec3f(0.0), vec3f(1.0));
      let linear = select(pow((c + 0.055) / 1.055, vec3f(2.4)), c / 12.92, c <= vec3f(0.04045));
      return pow(linear, vec3f(1.0 / 1.961));
    }
    @compute @workgroup_size(8,8)
    fn main(@builtin(global_invocation_id) id: vec3u) {
      if (id.x >= ${gw}u || id.y >= ${gh}u) { return; }
      let xy = vec2u(round(vec2f(id.xy) * vec2f(${w - 1}, ${h - 1}) / vec2f(${gw - 1}, ${gh - 1})));
      let uv = (vec2f(xy) + 0.5) / vec2f(${w}, ${h});
      let i = (id.y * ${gw}u + id.x) * 4u;
      result[i] = textureLoad(source, xy);
      result[i+1u] = textureSampleBaseClampToEdge(source, nearestSampler, uv);
      let filtered = textureSampleBaseClampToEdge(source, linearSampler, uv);
      result[i+2u] = filtered;
      result[i+3u] = vec4f(undoAppleTransfer(filtered.rgb), 1.0);
    }`});
  const pipeline = device.createComputePipeline({layout: "auto", compute: {module: shader, entryPoint: "main"}});
  const output = device.createBuffer({size, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC});
  const readback = device.createBuffer({size, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST});
  try {
    const group = device.createBindGroup({layout: pipeline.getBindGroupLayout(0), entries: [
      {binding: 0, resource: device.importExternalTexture({source: frame, colorSpace: "srgb"})},
      {binding: 1, resource: {buffer: output}},
      {binding: 2, resource: device.createSampler({minFilter: "nearest", magFilter: "nearest"})},
      {binding: 3, resource: device.createSampler({minFilter: "linear", magFilter: "linear"})},
    ]});
    const encoder = device.createCommandEncoder();
    const pass = encoder.beginComputePass();
    pass.setPipeline(pipeline); pass.setBindGroup(0, group);
    pass.dispatchWorkgroups(Math.ceil(gw/8), Math.ceil(gh/8)); pass.end();
    encoder.copyBufferToBuffer(output, 0, readback, 0, size);
    device.queue.submit([encoder.finish()]);
    await readback.mapAsync(GPUMapMode.READ);
    const data = new Float32Array(readback.getMappedRange().slice(0));
    readback.unmap();
    return {data, gw, gh};
  } finally { output.destroy(); readback.destroy(); }
}

function errors(reference, actual, transform = x => x) {
  let abs = 0, squared = 0, max = 0, signed = 0, exact = 0, maxRoundedError = 0;
  for (let i=0; i<reference.length; i++) {
    const value = 255 * clamp(transform(clamp(actual[i])));
    const diff = value - reference[i];
    abs += Math.abs(diff); squared += diff*diff; max = Math.max(max, Math.abs(diff)); signed += diff;
    if (Math.round(value) === reference[i]) exact++;
    maxRoundedError = Math.max(maxRoundedError, Math.abs(Math.round(value) - reference[i]));
  }
  return {mae: round(abs/reference.length), rmse: round(Math.sqrt(squared/reference.length)), max: Math.round(max * 1e6) / 1e6, bias: round(signed/reference.length), exactPercent: round(exact/reference.length*100), mismatches: reference.length - exact, maxRoundedError};
}

async function measure(device, frame, label) {
  if (isSlate && (frame.displayWidth !== 512 || frame.displayHeight !== 256)) {
    throw new RangeError("Slate measurements require the generated 512 × 256 fixture");
  }
  const {data, gw, gh} = await sampleGpu(device, frame);
  const w = frame.displayWidth, h = frame.displayHeight;
  const canvas = new OffscreenCanvas(w,h);
  const ctx = canvas.getContext("2d", {colorSpace: "srgb", willReadFrequently: true});
  ctx.drawImage(frame,0,0);
  const rgba = ctx.getImageData(0,0,w,h).data;
  const reference=[], samples=[[],[],[],[]], pairs=[];
  const panels = isSlate ? ["neutral ramp", "shadow steps", "vertical Cb edges", "horizontal Cr edges"].map(name => ({name, reference: [], samples: [[], [], [], []]})) : [];
  for (let y=0;y<gh;y++) for (let x=0;x<gw;x++) {
    const sx=Math.round(x*(w-1)/(gw-1)), sy=Math.round(y*(h-1)/(gh-1));
    const pi=(sy*w+sx)*4, gi=(y*gw+x)*16;
    for (let c=0;c<3;c++) {
      reference.push(rgba[pi+c]);
      for (let m=0;m<4;m++) samples[m].push(data[gi+m*4+c]);
      // Ignore four rows at panel boundaries to isolate the independent signals.
      if (panels.length && sy % 64 >= 4 && sy % 64 < 60) {
        const panel = panels[Math.floor(sy / 64)];
        panel.reference.push(rgba[pi+c]);
        for (let m=0;m<4;m++) panel.samples[m].push(data[gi+m*4+c]);
      }
    }
    if (pairs.length<6 && rgba[pi]>8 && rgba[pi]<220 && Math.abs(rgba[pi]-rgba[pi+1])<3 && Math.abs(rgba[pi]-rgba[pi+2])<3)
      pairs.push({x:sx,y:sy,cpu:[...rgba.slice(pi,pi+3)],gpu:[...data.slice(gi,gi+3)].map(v=>round(v*255)), corrected:[...data.slice(gi+12,gi+15)].map(v=>round(v*255))});
  }
  const transforms = {
    identity: x=>x, srgbEncode, srgbDecode,
    undoApple1961ToSrgb: x=>srgbDecode(x)**(1/1.961),
    undoGamma24ToSrgb: x=>srgbDecode(x)**(1/2.4),
    undoGamma22ToSrgb: x=>srgbDecode(x)**(1/2.2),
    undoBt709ToSrgb: x=>bt709Encode(srgbDecode(x)),
    bt709ToSrgb: x=>srgbEncode(bt709Decode(x)),
    limitedToFull: x=>(x*255-16)/219,
    fullToLimited: x=>(x*219+16)/255,
  };
  const fits = Object.fromEntries(Object.entries(transforms).map(([name,fn])=>[name,errors(reference,samples[0],fn)]));
  const buckets=Array.from({length:16},()=>({n:0,sum:0,sq:0}));
  reference.forEach((v,i)=>{const b=buckets[Math.min(15,Math.floor(v/16))]; b.n++; b.sum+=samples[0][i]*255; b.sq+=(samples[0][i]*255)**2;});
  return {label, format:frame.format, colorSpace:frame.colorSpace.toJSON(), width:w,height:h,samples:reference.length,
    panels: panels.map(p => ({name: p.name, samples: p.reference.length,
      original: errors(p.reference, p.samples[0]),
      transferOnly: errors(p.reference, p.samples[0], transforms.undoApple1961ToSrgb),
      linearOnly: errors(p.reference, p.samples[2]),
      combinedWgsl: errors(p.reference, p.samples[3])})),
    neutralSweep: isSlate ? [16,17,18,20,24,32,48,80,126,180,235].map(yCode => {
      const x = yCode * 2, y = 20, pi = (y*w+x)*4, gi=(y*gw+x)*16;
      const value = clamp((yCode-16)/219);
      return {yCode, referenceRgb: [...rgba.slice(pi,pi+3)], expectedRgb: round(value*255),
        external: round(data[gi]*255), predictedApple: round(srgbEncode(value**1.961)*255),
        corrected: round(data[gi+12]*255)};
    }) : undefined,
    fits, nearest:errors(reference,samples[1]),linear:errors(reference,samples[2]),
    correctedInWgsl: errors(reference,samples[3]),
    linearFits: Object.fromEntries(Object.entries(transforms).map(([name,fn])=>[name,errors(reference,samples[2],fn)])), pairs,
    buckets:buckets.map((b,i)=>({cpuRange:[i*16,i*16+15],n:b.n,gpuMean:round(b.sum/b.n)}))};
}

button.onclick = async () => {
  button.disabled = true;
  let hls, device, frame, software;
  const reports=[];
  try {
    status.textContent="Loading HLS…";
    const source=query.get("source") || "https://test-streams.mux.dev/x36xhzz/x36xhzz.m3u8";
    hls=new Hls(); hls.attachMedia(video); hls.loadSource(source);
    await new Promise((resolve,reject)=>{hls.on(Hls.Events.MANIFEST_PARSED,resolve); hls.on(Hls.Events.ERROR,(_e,d)=>{if(d.fatal)reject(new Error(d.details));});});
    await video.play();
    await new Promise(resolve=>video.requestVideoFrameCallback(resolve));
    video.currentTime=Number(query.get("seek") || (isSlate ? 0.5 : 30));
    await new Promise(resolve=>video.addEventListener("seeked",resolve,{once:true}));
    await new Promise(resolve=>video.requestVideoFrameCallback(resolve));
    frame=new VideoFrame(video); video.pause();
    const adapter=await navigator.gpu.requestAdapter(); device=await adapter.requestDevice();
    reports.push({userAgent:navigator.userAgent,adapter:adapter.info,source,time:video.currentTime});
    reports.push(await measure(device,frame,"decoded HLS"));
    status.textContent=JSON.stringify(reports,null,2);
    // Identical planes/metadata, but memory-backed instead of decoder-backed.
    try {
      const raw=new Uint8Array(frame.allocationSize()); const layout=await frame.copyTo(raw);
      if (isSlate) {
        const gold = new Uint8Array(await (await fetch(new URL("source.yuv", new URL(source, location.href)))).arrayBuffer());
        const width=frame.displayWidth, height=frame.displayHeight, ySize=width*height;
        if (width !== 512 || height !== 256 || gold.length !== ySize*1.5) throw new Error("Unexpected slate dimensions");
        if (!["NV12", "I420"].includes(frame.format)) throw new Error(`Unsupported slate plane comparison: ${frame.format}`);
        let maxCodeError=0, changedBytes=0;
        for (let plane=0;plane<3;plane++) {
          const pw=plane ? width/2 : width, ph=plane ? height/2 : height;
          const goldOffset=plane ? ySize+(plane-1)*ySize/4 : 0;
          const packed=plane && frame.format==="NV12";
          const l=layout[packed ? 1 : plane];
          for (let y=0;y<ph;y++) for(let x=0;x<pw;x++) {
            const index=l.offset+y*l.stride+(packed ? x*2+plane-1 : x);
            const difference=Math.abs(raw[index]-gold[goldOffset+y*pw+x]);
            maxCodeError=Math.max(maxCodeError,difference); if(difference)changedBytes++;
          }
        }
        reports.push({decodedPlanesVsOriginal: {maxCodeError,changedBytes,comparedBytes:gold.length}});
      }
      software=new VideoFrame(raw,{format:frame.format,codedWidth:frame.codedWidth,codedHeight:frame.codedHeight,
        visibleRect:frame.visibleRect,displayWidth:frame.displayWidth,displayHeight:frame.displayHeight,
        timestamp:0,colorSpace:frame.colorSpace.toJSON(),layout});
      reports.push(await measure(device,software,"same planes in software VideoFrame"));
    } catch(e) { reports.push({softwareCloneError:e.message}); }
    status.textContent=JSON.stringify(reports,null,2);
  } catch(error) {status.textContent=JSON.stringify(reports,null,2)+"\n"+error.stack;}
  finally {software?.close();frame?.close();device?.destroy();hls?.destroy();button.disabled=false;}
};
