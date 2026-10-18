/*
 * Browser WebGL2 port of the cool-retro-term Default Amber shader pipeline.
 * The source GLSL and assets are shipped in ./crt/upstream and ./crt/fonts.
 * This implementation adapts Qt's ShaderEffect uniforms, texture bindings,
 * and render targets to WebGL2. It does not claim native Qt pixel identity.
 * Upstream: Filippo Scognamiglio, cool-retro-term, GPL-3.0-or-later,
 * commit 1394ce82fa53d2a87d5adc4d99f9eeba598ea53d.
 */
const vertexSource = `#version 300 es
in vec2 position;
out vec2 uv;
void main(){ uv=position*.5+.5; gl_Position=vec4(position,0.,1.); }`;

// Port of upstream terminal_static.frag: the original weighted RGB offsets,
// radial coordinate warp, edge mask, and bloom contribution. Qt FastBlur's
// six downsample levels feed the same weighted composition as the QML source.
const staticSource = `#version 300 es
precision highp float;
in vec2 uv; out vec4 outColor;
uniform sampler2D source; uniform sampler2D bloom1; uniform sampler2D bloom2; uniform sampler2D bloom3; uniform sampler2D bloom4; uniform sampler2D bloom5; uniform sampler2D bloom6;
uniform vec2 bloomScale1;uniform vec2 bloomScale2;uniform vec2 bloomScale3;uniform vec2 bloomScale4;uniform vec2 bloomScale5;uniform vec2 bloomScale6;uniform vec2 bloomOffset1;uniform vec2 bloomOffset2;uniform vec2 bloomOffset3;uniform vec2 bloomOffset4;uniform vec2 bloomOffset5;uniform vec2 bloomOffset6;
uniform vec2 viewport; uniform float screenCurvature; uniform float frameSize;
uniform float bloom; uniform float screenBrightness; uniform float frameShininess;
uniform float bloomWeight1; uniform float bloomWeight2; uniform float bloomWeight3; uniform float bloomWeight4; uniform float bloomWeight5; uniform float bloomWeight6;
vec2 distort(vec2 p){ vec2 q=p*(1.+frameSize*2.)-frameSize; vec2 c=q-.5; float d=dot(c,c)*screenCurvature; return q+c*(1.+d)*d; }
float rand2(vec2 v){return fract(sin(dot(v,vec2(12.9898,78.233)))*43758.5453);}
float min2(vec2 v){return min(v.x,v.y);} float max2(vec2 v){return max(v.x,v.y);}
void main(){
 vec2 cc=.5-uv; vec2 warped=distort(uv);
 vec2 inRange=step(vec2(0.),warped)-step(vec2(1.),warped);
 float shown=max2(inRange); float isScreen=min2(inRange); float reflection=shown-isScreen;
 vec2 sampleUv=warped*(-1.+2.*step(vec2(0.),warped)-2.*step(vec2(1.),warped));
 vec3 texel=texture(source,sampleUv).rgb;
 vec3 leftColor=texture(source,sampleUv).rgb;
 vec3 rightColor=leftColor;
 texel.r=leftColor.r*.10+rightColor.r*.30+texel.r*.60;
 texel.g=leftColor.g*.20+rightColor.g*.20+texel.g*.60;
 texel.b=leftColor.b*.30+rightColor.b*.10+texel.b*.60;
 vec3 finalColor=texel*shown;
 vec4 bloomTex=texture(bloom1,sampleUv*bloomScale1+bloomOffset1)*bloomWeight1+texture(bloom2,sampleUv*bloomScale2+bloomOffset2)*bloomWeight2+texture(bloom3,sampleUv*bloomScale3+bloomOffset3)*bloomWeight3+texture(bloom4,sampleUv*bloomScale4+bloomOffset4)*bloomWeight4+texture(bloom5,sampleUv*bloomScale5+bloomOffset5)*bloomWeight5+texture(bloom6,sampleUv*bloomScale6+bloomOffset6)*bloomWeight6; vec3 bloomColor=bloomTex.rgb; float bloomAlpha=bloomTex.a;
 finalColor+=clamp((bloomColor*isScreen)*bloom*bloomAlpha,0.,.5);
 finalColor/=(1.+max(bloom,0.));
 vec3 reflectionColor=mix(bloomColor*bloomAlpha*2.,finalColor,frameShininess*.5);
 finalColor=mix(finalColor,reflectionColor,reflection);
 finalColor*=screenBrightness;
 finalColor=clamp(finalColor+vec3((rand2(uv)-.5)*.025),0.,1.);
 outColor=vec4(finalColor,1.);
}`;

// Port of upstream terminal_dynamic.vert/frag. Default Amber uses rasterization
// 0, chroma 0.2, burn-in 0.3, noise 0.1, glow 0.2*0.2, jitter 0.2 and flicker 0.1.
const dynamicSource = `#version 300 es
precision highp float;
in vec2 uv; out vec4 outColor;
uniform sampler2D noiseSource; uniform sampler2D screenBuffer; uniform sampler2D burnInSource; uniform sampler2D frameSource;
uniform vec2 viewportResolution; uniform vec2 noiseScale; uniform float time;
uniform vec4 fontColor; uniform vec4 backgroundColor; uniform float staticNoise;
uniform float screenCurvature; uniform float frameSize; uniform float glowingLine; uniform float chromaColor;
uniform vec2 jitterDisplacement; uniform float jitter; uniform float flickering;
uniform float horizontalSync; uniform float horizontalSyncStrength; uniform float burnInEnabled;
uniform float burnInLastUpdate; uniform float burnInTime; uniform float bloom;
float min2(vec2 v){return min(v.x,v.y);} float rgb2grey(vec3 v){return dot(v,vec3(.21,.72,.04));}
vec2 distort(vec2 p){vec2 q=p*(1.+frameSize*2.)-frameSize;vec2 c=q-.5;float d=dot(c,c)*screenCurvature;return q+c*(1.+d)*d;}
float randomPass(vec2 p){return fract(smoothstep(-120.,0.,p.y-(viewportResolution.y+120.)*fract(time*.15)));}
vec3 convertChroma(vec3 c){float g=rgb2grey(c);float den=max(g,.0001);vec3 fg=mix(fontColor.rgb,c*fontColor.rgb/den,chromaColor);return mix(backgroundColor.rgb,fg,g);}
void main(){
 vec2 cc=.5-uv;float distance=length(cc);vec2 staticCoords=distort(uv);
 vec4 initialNoise=texture(noiseSource,vec2(fract(time/2.048),fract(time/1048.576)));
 float syncRand=horizontalSyncStrength-initialNoise.r;
 float distortion=step(0.,syncRand)*syncRand*horizontalSyncStrength*horizontalSync;
 float distortionFreq=mix(4.,40.,initialNoise.g)*step(0.,horizontalSync);
 vec2 coords=uv; float dst=sin((coords.y+time)*distortionFreq); coords.x+=dst*distortion;
 vec4 n=texture(noiseSource,noiseScale*coords+vec2(fract(time/.051),fract(time/.237)));
 vec2 textCoords=coords+(n.ba-.5)*jitterDisplacement*jitter;
 vec4 frame=texture(frameSource,uv);
 float noiseValue=n.a*staticNoise*(1.-distance*1.3)+randomPass(coords*viewportResolution)*glowingLine;
 noiseValue*=1.-frame.a;
 vec3 textColor=texture(screenBuffer,textCoords).rgb*(1.+max(bloom,0.));
 vec4 old=texture(burnInSource,staticCoords);float decay=clamp((time-burnInLastUpdate)*burnInTime,0.,1.);
 textColor=max(textColor,.65*(old.rgb-vec3(decay))*(1.-old.a)*burnInEnabled);
 textColor+=vec3(noiseValue);
 vec3 finalColor=convertChroma(textColor);
 float flicker=1.+(initialNoise.g-.5)*flickering;
 finalColor*=flicker;
 finalColor=mix(finalColor,frame.rgb,frame.a);
 outColor=vec4(finalColor,1.);
}`;

const blurSource = `#version 300 es
precision highp float; in vec2 uv; out vec4 outColor;
uniform sampler2D source; uniform vec2 xStep; uniform vec2 yStep;
void main(){vec4 c=(texture(source,uv+xStep+yStep*.36)+texture(source,uv+xStep*.36-yStep)+texture(source,uv-xStep*.36+yStep)+texture(source,uv-xStep-yStep*.36))*.25;outColor=c;}`;

const downsampleSource = `#version 300 es
precision highp float;in vec2 uv;out vec4 outColor;uniform sampler2D source;uniform vec2 outputSize;uniform vec2 inputSize;uniform float padding;
void main(){vec2 p=uv*outputSize-padding;vec2 q=p/(outputSize-2.*padding);if(any(lessThan(q,vec2(0.)))||any(greaterThan(q,vec2(1.))))outColor=vec4(0.);else outColor=texture(source,q);}`;

const burnSource = `#version 300 es
precision highp float; in vec2 uv; out vec4 outColor;
uniform sampler2D textSource; uniform sampler2D previous; uniform float fade;
float grey(vec3 c){return dot(c,vec3(.21,.72,.04));}
void main(){vec3 text=texture(textSource,uv).rgb;vec4 prior=texture(previous,uv);float decay=clamp(fade-prior.a,0.,1.);vec3 color=max(prior.rgb-vec3(decay),text);float mask=step(grey(color),grey(text));outColor=vec4(color,mask);}`;

// Port of upstream terminal_frame.frag: rounded-edge mask, curved-glass
// shading, ambient highlight and frame tint blended into the final signal.
const frameSource = `#version 300 es
precision highp float;in vec2 uv;out vec4 outColor;uniform vec2 viewport;uniform float screenCurvature;uniform float frameSize;uniform float screenRadius;uniform float ambientLight;uniform float frameShininess;uniform vec3 frameColor;
float min2(vec2 v){return min(v.x,v.y);}float prod2(vec2 v){return v.x*v.y;}float rand2(vec2 v){return fract(sin(dot(v,vec2(12.9898,78.233)))*43758.5453);}
vec2 distort(vec2 p){vec2 q=p*(1.+frameSize*2.)-frameSize;vec2 c=q-.5;float d=dot(c,c)*screenCurvature;return q+c*(1.+d)*d;}
float roundedSdf(vec2 p,float r){vec2 local=(p-.5)*viewport;vec2 halfSize=viewport*.5-vec2(r);vec2 d=abs(local)-halfSize;return length(max(d,vec2(0.)))+min(max(d.x,d.y),0.)-r;}
void main(){vec2 coords=distort(uv);float edgeSoft=1.;float seam=max(screenRadius,.5)/min(viewport.x,viewport.y);float e=min(smoothstep(-seam,seam,coords.x-coords.y),smoothstep(-seam,seam,coords.x-(1.-coords.y)));float s=min(smoothstep(-seam,seam,coords.y-coords.x),smoothstep(-seam,seam,coords.x-(1.-coords.y)));float w=min(smoothstep(-seam,seam,coords.y-coords.x),smoothstep(-seam,seam,(1.-coords.x)-coords.y));float n=min(smoothstep(-seam,seam,coords.x-coords.y),smoothstep(-seam,seam,(1.-coords.x)-coords.y));float dist=roundedSdf(coords,screenRadius);float frameShadow=(e*.66+w*.66+n*.33+s)*smoothstep(0.,edgeSoft*5.,dist);float frameAlpha=1.-frameShininess*.4;float inScreen=smoothstep(0.,edgeSoft,-dist);float alpha=mix(frameAlpha,mix(0.,.3,ambientLight),inScreen);float glass=clamp(ambientLight*pow(prod2(coords*(1.-coords.yx))*25.,.5)*inScreen,0.,1.);vec3 tint=frameColor*frameShadow;tint=clamp(tint+vec3((rand2(uv*viewport)-.5)*.04),0.,1.);vec3 color=mix(tint,vec3(glass),inScreen);outColor=vec4(color,alpha);}`;

function createShader(gl, type, source) {
  const shader = gl.createShader(type); gl.shaderSource(shader, source); gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) { const error = gl.getShaderInfoLog(shader); gl.deleteShader(shader); throw new Error(error || 'Shader compilation failed'); }
  return shader;
}
function createProgram(gl, fragment) {
  const program = gl.createProgram(); gl.attachShader(program, createShader(gl, gl.VERTEX_SHADER, vertexSource)); gl.attachShader(program, createShader(gl, gl.FRAGMENT_SHADER, fragment)); gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(program) || 'Shader link failed');
  return program;
}
function rgba(hex) { const value = Number.parseInt(hex.slice(1), 16); return [(value >> 16 & 255) / 256, (value >> 8 & 255) / 256, (value & 255) / 256]; }
function mix(a,b,t) { return a.map((value,index) => value*(1-t)+b[index]*t); }
function amberPalette() {
  const raw=rgba('#ff8100'), white=rgba('#ffffff'), black=[0,0,0];
  const saturated=mix(raw,white,.2*.5), contrast=.7+.8*.3;
  const font=mix(black,saturated,contrast), background=mix(saturated,black,contrast);
  const light=mix(font,background,.2), frameBase=[.809+.1,.809+.1,.809+.1], frame=mix(mix(light,black,.8),frameBase,.125+.75*.3);
  return { font:[...font,1], background:[...background,1], frame };
}
export function createCrtRenderer(canvas, { onFallback = () => {} } = {}) {
  let gl=null, alive=true, raf=0, staticDirty=true, textCanvas=document.createElement('canvas'), textCtx=textCanvas.getContext('2d'), glyphCanvas=document.createElement('canvas'), glyphCtx=glyphCanvas.getContext('2d');
  let programs={}, textures={}, framebuffers={}, cssWidth=0, cssHeight=0, renderScale=1, textContent='', latestSourceLine=0, latestWrappedLine=0, visibleFirstLine='', scrollOffset=Infinity, maxScroll=0, lastTextUpdate=performance.now()/1000, reduced=matchMedia('(prefers-reduced-motion: reduce)').matches, pipelineVerified=false;
  const palette=amberPalette();
  function makeTexture(width,height,{filter='linear',wrap='clamp'}={}) {
    const texture=gl.createTexture(); gl.bindTexture(gl.TEXTURE_2D,texture); gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MIN_FILTER,filter==='nearest'?gl.NEAREST:gl.LINEAR); gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MAG_FILTER,filter==='nearest'?gl.NEAREST:gl.LINEAR); gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_S,wrap==='repeat'?gl.REPEAT:gl.CLAMP_TO_EDGE); gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_T,wrap==='repeat'?gl.REPEAT:gl.CLAMP_TO_EDGE); gl.texImage2D(gl.TEXTURE_2D,0,gl.RGBA8,width,height,0,gl.RGBA,gl.UNSIGNED_BYTE,null); return texture;
  }
  function target(texture) { const fb=gl.createFramebuffer(); gl.bindFramebuffer(gl.FRAMEBUFFER,fb); gl.framebufferTexture2D(gl.FRAMEBUFFER,gl.COLOR_ATTACHMENT0,gl.TEXTURE_2D,texture,0); if(gl.checkFramebufferStatus(gl.FRAMEBUFFER)!==gl.FRAMEBUFFER_COMPLETE) throw new Error('CRT render target unavailable'); return fb; }
  function resize() {
    if(!gl)return;const cssW=canvas.clientWidth,cssH=canvas.clientHeight;if(cssW<2||cssH<2)return;const ratio=Math.min(devicePixelRatio||1,1.5,2048/cssW,1440/cssH), width=Math.max(2,Math.round(cssW*ratio)),height=Math.max(2,Math.round(cssH*ratio));
    cssWidth=cssW;cssHeight=cssH;renderScale=ratio;if(width===canvas.width&&height===canvas.height)return; canvas.width=width; canvas.height=height;
    const noiseTexture=textures.noise;for(const item of Object.values(textures))if(item!==noiseTexture)gl.deleteTexture(item);for(const item of Object.values(framebuffers))gl.deleteFramebuffer(item);
    const w=width,h=height,ratioScale=ratio, firstW=Math.min(2048,Math.max(2,Math.ceil((w*.5+128*ratioScale)/32)*32)),firstH=Math.min(1440,Math.max(2,Math.ceil((h*.5+128*ratioScale)/32)*32));
    bloomSizes=[{width:firstW,height:firstH}];for(let i=1;i<6;i++)bloomSizes.push({width:Math.max(2,Math.floor(bloomSizes[i-1].width/2)),height:Math.max(2,Math.floor(bloomSizes[i-1].height/2))});
    textures={noise:noiseTexture,text:makeTexture(w,h),curved:makeTexture(w,h),frame:makeTexture(w,h),burnA:makeTexture(w,h),burnB:makeTexture(w,h)};framebuffers={curved:target(textures.curved),frame:target(textures.frame),burnA:target(textures.burnA),burnB:target(textures.burnB)};
    for(let i=0;i<6;i++){textures[`bloom${i+1}`]=makeTexture(bloomSizes[i].width,bloomSizes[i].height);framebuffers[`bloom${i+1}`]=target(textures[`bloom${i+1}`]);}
    gl.clearColor(0,0,0,0);for(const framebuffer of Object.values(framebuffers)){gl.bindFramebuffer(gl.FRAMEBUFFER,framebuffer);gl.clear(gl.COLOR_BUFFER_BIT);}burnFlip=false;burnNeedsUpdate=true;previousBurnUpdate=lastTextUpdate;
    staticDirty=true;gl.bindFramebuffer(gl.FRAMEBUFFER,null); drawText(true);
  }
  function drawText(force=false) {
    if(!gl || !textCtx || !textures.text || canvas.clientWidth<2 || canvas.clientHeight<2 || (!force && textContent===textCtx.__lastText)) return;
    const width=canvas.width,height=canvas.height; textCanvas.width=width;textCanvas.height=height;
    // Qt's lowResolutionFont rasterizes the source glyphs at a fixed 12px,
    // independent of device pixel ratio, then nearest-neighbor scales them.
    const sourceScale=2, sourceWidth=Math.max(1,Math.ceil(canvas.clientWidth/sourceScale)),sourceHeight=Math.max(1,Math.ceil(canvas.clientHeight/sourceScale));glyphCanvas.width=sourceWidth;glyphCanvas.height=sourceHeight;
    glyphCtx.fillStyle='#000';glyphCtx.fillRect(0,0,sourceWidth,sourceHeight);glyphCtx.fillStyle='#fff';const fs=12;glyphCtx.font=`${fs}px Terminess, monospace`;glyphCtx.textBaseline='top';
    const pad=Math.max(16,Math.round(sourceWidth*.035)), line=fs*1.48, maxWidth=sourceWidth-pad*2, wrapped=[];
    for(const [sourceIndex,item] of textContent.split('\n').entries()){
      if(sourceIndex===latestSourceLine)latestWrappedLine=wrapped.length;
      if(!item){wrapped.push('');continue;}
      let current='';
      for(const word of item.split(/\s+/)){
        if(glyphCtx.measureText(word).width<=maxWidth){
          const candidate=current?`${current} ${word}`:word;
          if(glyphCtx.measureText(candidate).width>maxWidth&&current){wrapped.push(current);current=word;}else current=candidate;
          continue;
        }
        if(current){wrapped.push(current);current='';}
        let part='';
        for(const character of Array.from(word)){
          if(part&&glyphCtx.measureText(part+character).width>maxWidth){wrapped.push(part);part=character;}else part+=character;
        }
        current=part;
      }
      if(current)wrapped.push(current);
    }
    const maxLines=Math.max(1,Math.floor((sourceHeight-pad*2)/line));maxScroll=Math.max(0,wrapped.length-maxLines);if(scrollOffset===Infinity)scrollOffset=Math.min(latestWrappedLine,maxScroll);else scrollOffset=Math.min(scrollOffset,maxScroll);const visible=wrapped.slice(scrollOffset,scrollOffset+maxLines);visibleFirstLine=visible[0]||'';
    visible.forEach((value,index)=>glyphCtx.fillText(value,pad,pad+index*line));
    const glyphMask=glyphCtx.getImageData(0,0,sourceWidth,sourceHeight), maskPixels=glyphMask.data;
    for(let index=0;index<maskPixels.length;index+=4){const value=maskPixels[index]>=128?255:0;maskPixels[index]=value;maskPixels[index+1]=value;maskPixels[index+2]=value;maskPixels[index+3]=255;}
    glyphCtx.putImageData(glyphMask,0,0);
    textCtx.fillStyle='#000';textCtx.fillRect(0,0,width,height);textCtx.imageSmoothingEnabled=false;textCtx.drawImage(glyphCanvas,0,0,width,height);
    textCtx.__lastText=textContent;
    gl.bindTexture(gl.TEXTURE_2D,textures.text);gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL,true);gl.texImage2D(gl.TEXTURE_2D,0,gl.RGBA,gl.RGBA,gl.UNSIGNED_BYTE,textCanvas);previousBurnUpdate=lastTextUpdate;lastTextUpdate=performance.now()/1000;burnNeedsUpdate=true;
    staticDirty=true;
  }
  function bind(name, program, textureName, index) { gl.activeTexture(gl.TEXTURE0+index);gl.bindTexture(gl.TEXTURE_2D,textures[textureName]);gl.uniform1i(gl.getUniformLocation(program,name),index); }
  function checkFirstFrame(stage){if(pipelineVerified)return true;const error=gl.getError();if(error===gl.NO_ERROR)return true;alive=false;cancelAnimationFrame(raf);onFallback(new Error(`The CRT WebGL ${stage} pass failed with code ${error}.`));return false;}
  function requestRender(){if(!alive||!gl||document.visibilityState==='hidden'||raf)return;raf=requestAnimationFrame(render);}
  function render(nowMs) {
    raf=0;
    if(!alive||!gl||document.visibilityState==='hidden')return;
    if(canvas.clientWidth<2||canvas.clientHeight<2){raf=0;return;}
    resize();drawText();const time=reduced?0:nowMs/1000, w=canvas.width,h=canvas.height;
    const qmlScale=1024/Math.max(1,((cssWidth||canvas.clientWidth)+(cssHeight||canvas.clientHeight))*.5),curvature=.12*qmlScale,frameSize=.005*qmlScale;
    gl.bindVertexArray(vao);
    if(staticDirty){
    const downProgram=programs.downsample;
    gl.useProgram(downProgram);bind('source',downProgram,'text',0);gl.bindFramebuffer(gl.FRAMEBUFFER,framebuffers.bloom1);gl.viewport(0,0,bloomSizes[0].width,bloomSizes[0].height);gl.uniform2f(gl.getUniformLocation(downProgram,'outputSize'),bloomSizes[0].width,bloomSizes[0].height);gl.uniform2f(gl.getUniformLocation(downProgram,'inputSize'),w,h);gl.uniform1f(gl.getUniformLocation(downProgram,'padding'),64*renderScale);gl.drawArrays(gl.TRIANGLES,0,6);if(!checkFirstFrame('bloom downsample'))return;
    for(let i=1;i<6;i++){
      const input=`bloom${i}`,output=`bloom${i+1}`,size=bloomSizes[i];
      gl.useProgram(programs.blur);bind('source',programs.blur,input,0);gl.bindFramebuffer(gl.FRAMEBUFFER,framebuffers[output]);gl.viewport(0,0,size.width,size.height);gl.uniform2f(gl.getUniformLocation(programs.blur,'xStep'),1/size.width,0);gl.uniform2f(gl.getUniformLocation(programs.blur,'yStep'),0,1/size.height);gl.drawArrays(gl.TRIANGLES,0,6);if(!checkFirstFrame(`bloom blur level ${i+1}`))return;
    }
    gl.useProgram(programs.static);bind('source',programs.static,'text',0);for(let i=0;i<6;i++){const n=i+1,size=bloomSizes[i],contentW=(w*.5)/2**i,contentH=(h*.5)/2**i,pad=(64*renderScale)/2**i;bind(`bloom${n}`,programs.static,`bloom${n}`,n);gl.uniform2f(gl.getUniformLocation(programs.static,`bloomScale${n}`),contentW/size.width,contentH/size.height);gl.uniform2f(gl.getUniformLocation(programs.static,`bloomOffset${n}`),pad/size.width,pad/size.height);}gl.bindFramebuffer(gl.FRAMEBUFFER,framebuffers.curved);gl.viewport(0,0,w,h);gl.uniform2f(gl.getUniformLocation(programs.static,'viewport'),w,h);gl.uniform1f(gl.getUniformLocation(programs.static,'screenCurvature'),curvature);gl.uniform1f(gl.getUniformLocation(programs.static,'frameSize'),frameSize);gl.uniform1f(gl.getUniformLocation(programs.static,'bloom'),1.5);gl.uniform1f(gl.getUniformLocation(programs.static,'screenBrightness'),1);gl.uniform1f(gl.getUniformLocation(programs.static,'frameShininess'),.15);
    const lod=Math.sqrt(40/64)*1.2-.2, candidates=[.1,.3,.5,.7,.9,1.1].map(value=>Math.max(0,1-Math.abs(lod-value)*2)),sum=candidates.reduce((a,b)=>a+b,0);candidates.forEach((value,index)=>gl.uniform1f(gl.getUniformLocation(programs.static,`bloomWeight${index+1}`),value/sum));gl.drawArrays(gl.TRIANGLES,0,6);if(!checkFirstFrame('curvature and bloom composition'))return;
    gl.useProgram(programs.frame);gl.bindFramebuffer(gl.FRAMEBUFFER,framebuffers.frame);gl.viewport(0,0,w,h);gl.uniform2f(gl.getUniformLocation(programs.frame,'viewport'),w,h);gl.uniform1f(gl.getUniformLocation(programs.frame,'screenCurvature'),curvature);gl.uniform1f(gl.getUniformLocation(programs.frame,'frameSize'),frameSize);gl.uniform1f(gl.getUniformLocation(programs.frame,'screenRadius'),15.6*renderScale);gl.uniform1f(gl.getUniformLocation(programs.frame,'ambientLight'),.3);gl.uniform1f(gl.getUniformLocation(programs.frame,'frameShininess'),.15);gl.uniform3fv(gl.getUniformLocation(programs.frame,'frameColor'),palette.frame);gl.drawArrays(gl.TRIANGLES,0,6);if(!checkFirstFrame('terminal frame composition'))return;
    staticDirty=false;
    }
    const burnRead=burnFlip?'burnB':'burnA',burnWrite=burnFlip?'burnA':'burnB';
    if(burnNeedsUpdate){gl.useProgram(programs.burn);bind('textSource',programs.burn,'text',0);bind('previous',programs.burn,burnRead,1);gl.bindFramebuffer(gl.FRAMEBUFFER,framebuffers[burnWrite]);gl.viewport(0,0,w,h);gl.uniform1f(gl.getUniformLocation(programs.burn,'fade'),Math.min(1,Math.max(0,(lastTextUpdate-previousBurnUpdate)*1.69)));gl.drawArrays(gl.TRIANGLES,0,6);if(!checkFirstFrame('phosphor persistence'))return;burnFlip=!burnFlip;burnNeedsUpdate=false;}
    const currentBurn=burnFlip?'burnB':'burnA';
    gl.useProgram(programs.dynamic);bind('noiseSource',programs.dynamic,'noise',0);bind('screenBuffer',programs.dynamic,'curved',1);bind('burnInSource',programs.dynamic,currentBurn,2);bind('frameSource',programs.dynamic,'frame',3);gl.bindFramebuffer(gl.FRAMEBUFFER,null);gl.viewport(0,0,w,h);gl.uniform2f(gl.getUniformLocation(programs.dynamic,'viewportResolution'),w,h);gl.uniform2f(gl.getUniformLocation(programs.dynamic,'noiseScale'),w*.75/512,h*.75/512);gl.uniform1f(gl.getUniformLocation(programs.dynamic,'time'),time);gl.uniform4fv(gl.getUniformLocation(programs.dynamic,'fontColor'),palette.font);gl.uniform4fv(gl.getUniformLocation(programs.dynamic,'backgroundColor'),palette.background);gl.uniform1f(gl.getUniformLocation(programs.dynamic,'staticNoise'),.1);gl.uniform1f(gl.getUniformLocation(programs.dynamic,'screenCurvature'),curvature);gl.uniform1f(gl.getUniformLocation(programs.dynamic,'frameSize'),frameSize);gl.uniform1f(gl.getUniformLocation(programs.dynamic,'glowingLine'),reduced?0:.04);gl.uniform1f(gl.getUniformLocation(programs.dynamic,'chromaColor'),.2);gl.uniform2f(gl.getUniformLocation(programs.dynamic,'jitterDisplacement'),.0014,.0004);gl.uniform1f(gl.getUniformLocation(programs.dynamic,'jitter'),reduced?0:.2);gl.uniform1f(gl.getUniformLocation(programs.dynamic,'flickering'),reduced?0:.1);gl.uniform1f(gl.getUniformLocation(programs.dynamic,'horizontalSync'),reduced?0:.1);gl.uniform1f(gl.getUniformLocation(programs.dynamic,'horizontalSyncStrength'),.08);gl.uniform1f(gl.getUniformLocation(programs.dynamic,'burnInLastUpdate'),lastTextUpdate);gl.uniform1f(gl.getUniformLocation(programs.dynamic,'burnInTime'),1.69);gl.uniform1f(gl.getUniformLocation(programs.dynamic,'burnInEnabled'),reduced?0:1);gl.uniform1f(gl.getUniformLocation(programs.dynamic,'bloom'),1.5);gl.drawArrays(gl.TRIANGLES,0,6);
    if(!checkFirstFrame('dynamic signal'))return;pipelineVerified=true;
    if(!reduced)requestRender();
  }
  let vao=null,burnFlip=false,burnNeedsUpdate=true,previousBurnUpdate=0,bloomSizes=[];
  function init() {
    gl=canvas.getContext('webgl2',{alpha:false,antialias:false,preserveDrawingBuffer:false}); if(!gl)throw new Error('WebGL 2 is not available');
    programs={static:createProgram(gl,staticSource),dynamic:createProgram(gl,dynamicSource),blur:createProgram(gl,blurSource),burn:createProgram(gl,burnSource),frame:createProgram(gl,frameSource),downsample:createProgram(gl,downsampleSource)};
    vao=gl.createVertexArray();gl.bindVertexArray(vao);const buffer=gl.createBuffer();gl.bindBuffer(gl.ARRAY_BUFFER,buffer);gl.bufferData(gl.ARRAY_BUFFER,new Float32Array([-1,-1,1,-1,-1,1,-1,1,1,-1,1,1]),gl.STATIC_DRAW);const location=gl.getAttribLocation(programs.static,'position');gl.enableVertexAttribArray(location);gl.vertexAttribPointer(location,2,gl.FLOAT,false,0,0);
    textures.noise=gl.createTexture();gl.bindTexture(gl.TEXTURE_2D,textures.noise);gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MIN_FILTER,gl.LINEAR);gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MAG_FILTER,gl.LINEAR);gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_S,gl.REPEAT);gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_T,gl.REPEAT);
    const noise=new Image();noise.onload=()=>{if(!gl)return;gl.bindTexture(gl.TEXTURE_2D,textures.noise);gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL,true);gl.texImage2D(gl.TEXTURE_2D,0,gl.RGBA,gl.RGBA,gl.UNSIGNED_BYTE,noise);requestRender();};noise.onerror=()=>{onFallback(new Error('The licensed upstream static texture could not load.'));};noise.src=new URL('./crt/allNoise512.png',import.meta.url).href;
  }
  try { init(); } catch(error) { alive=false;onFallback(error); }
  document.fonts.load('20px Terminess').then(fonts=>{
    if(!alive)return;
    if(!fonts.length){alive=false;onFallback(new Error('The licensed Terminess terminal font could not be loaded.'));return;}
    if(textCtx){textCtx.__lastText=null;drawText(true);}
    requestRender();
  }).catch(error=>{if(alive){alive=false;onFallback(new Error(`The licensed Terminess terminal font could not be loaded: ${error.message}`));}});
  canvas.addEventListener('webglcontextlost',event=>{event.preventDefault();cancelAnimationFrame(raf);raf=0;gl=null;onFallback(new Error('The CRT graphics context was lost. The readable transcript remains available.'));});
  const observer=new ResizeObserver(()=>{resize();requestRender();});observer.observe(canvas);
  document.addEventListener('visibilitychange',()=>{if(document.visibilityState==='hidden'){cancelAnimationFrame(raf);raf=0;}else requestRender();});
  const renderer = {
    setText(value,follow=true,latestLine=0){if(value!==textContent){textContent=value;latestSourceLine=Math.max(0,Math.trunc(latestLine));if(follow)scrollOffset=Infinity;}drawText(true);requestRender();},
    scrollBy(lines){if(scrollOffset===Infinity)scrollOffset=Math.min(latestWrappedLine,maxScroll);scrollOffset=Math.max(0,Math.min(maxScroll,scrollOffset+Math.trunc(lines)));drawText(true);requestRender();},
    setScroll(value){scrollOffset=Math.max(0,Math.min(maxScroll,Math.trunc(value)));drawText(true);requestRender();},
    getScrollState(){const offset=scrollOffset===Infinity?Math.min(latestWrappedLine,maxScroll):scrollOffset;return {offset,max:maxScroll,latestStart:Math.min(latestWrappedLine,maxScroll),visibleFirstLine,atEnd:offset>=maxScroll};},
    destroy(){alive=false;cancelAnimationFrame(raf);observer.disconnect();gl=null;}, get active(){return Boolean(alive&&gl);}
  };
  canvas.__missionCrtRenderer = renderer;
  return renderer;
}
