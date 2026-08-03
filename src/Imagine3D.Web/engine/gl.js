// WebGL2 plumbing: context, shader compilation with #include support, render
// targets and the fullscreen quad every 2D effect draws on.

export const VERTEX_SHADER = `#version 300 es
precision highp float;
layout(location=0) in vec2 aPos;
out vec2 vUv;
void main() {
  vUv = aPos * 0.5 + 0.5;
  gl_Position = vec4(aPos, 0.0, 1.0);
}`;

/** Uniforms every effect receives, declared once so shaders can just use them. */
export const UNIFORM_PREAMBLE = `#version 300 es
precision highp float;
precision highp int;

in vec2 vUv;
out vec4 fragColor;

uniform vec2  uResolution;
uniform float uAspect;
uniform float uTime;        // seconds into the song
uniform float uSceneT;      // 0..1 through the current scene
uniform float uSectionT;    // 0..1 through the current section
uniform float uAmount;      // wet/dry for post effects

// Music. See engine/modulation.js for how each is derived.
uniform float uBeat;        // 0..1 sawtooth per beat
uniform float uBeatPulse;   // 1.0 on the hit, decaying
uniform float uBar;
uniform float uBarPulse;
uniform float uPhrase;
uniform float uOnset;
uniform float uRms;
uniform float uEnergy;
uniform float uSub, uBass, uLowMid, uMid, uHigh, uAir;

uniform sampler2D uPrev;      // what this pass is drawing on top of
uniform sampler2D uNext;      // transitions only: the incoming scene
uniform sampler2D uFeedback;  // the previous frame, for trails and echo
uniform sampler2D uVideo;     // LTX clip, when one is active
uniform sampler2D uText;      // rendered lyric/scroller layer
uniform float uVideoAmount;
uniform int   uBlendMode;     // index into blendMode() in shaders/blend.glsl
uniform float uSeed;          // per-run seed, so noise differs between videos

uniform vec3 uPal0, uPal1, uPal2, uPal3, uPal4;
`;

export function createGL(canvas) {
  const gl = canvas.getContext('webgl2', {
    alpha: false,
    depth: true,
    stencil: false,
    antialias: false,
    // Needed so readPixels sees the drawn frame; without it the buffer may be
    // cleared before we get to read it.
    preserveDrawingBuffer: true,
    powerPreference: 'high-performance',
    desynchronized: false,
  });
  if (!gl) throw new Error('WebGL2 is not available in this webview.');

  // Float render targets keep post-processing chains from banding badly.
  gl.getExtension('EXT_color_buffer_float');
  gl.getExtension('OES_texture_float_linear');

  return gl;
}

/** Reports whether we are on a real GPU or a software fallback. */
export function describeRenderer(gl) {
  const dbg = gl.getExtension('WEBGL_debug_renderer_info');
  const renderer = dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER);
  const vendor = dbg ? gl.getParameter(dbg.UNMASKED_VENDOR_WEBGL) : gl.getParameter(gl.VENDOR);
  const software = /swiftshader|llvmpipe|software|basic render/i.test(String(renderer));
  return { renderer: String(renderer), vendor: String(vendor), software };
}

// ---------------------------------------------------------------- includes

const includeCache = new Map();

async function fetchInclude(name) {
  if (includeCache.has(name)) return includeCache.get(name);
  const res = await fetch(`shaders/${name}`);
  if (!res.ok) throw new Error(`shader include not found: shaders/${name}`);
  const text = await res.text();
  includeCache.set(name, text);
  return text;
}

/** Resolve `#include "file.glsl"` recursively, guarding against cycles. */
export async function resolveIncludes(source, seen = new Set()) {
  const re = /^[ \t]*#include\s+"([^"]+)"\s*$/gm;
  const names = [...source.matchAll(re)].map((m) => m[1]);
  if (names.length === 0) return source;

  const bodies = new Map();
  for (const name of names) {
    if (seen.has(name)) { bodies.set(name, ''); continue; }
    seen.add(name);
    bodies.set(name, await resolveIncludes(await fetchInclude(name), seen));
  }

  return source.replace(re, (_, name) => bodies.get(name) ?? '');
}

// ---------------------------------------------------------------- programs

function compileStage(gl, type, source, label) {
  const sh = gl.createShader(type);
  gl.shaderSource(sh, source);
  gl.compileShader(sh);
  if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(sh) ?? '';
    gl.deleteShader(sh);
    throw new Error(`${label} failed to compile:\n${log}\n${numberLines(source, log)}`);
  }
  return sh;
}

/** Show the offending lines with numbers - GLSL errors are useless without this. */
function numberLines(src, log) {
  const m = /(\d+):(\d+)/.exec(log);
  const lines = src.split('\n');
  if (!m) return '';
  const target = parseInt(m[2], 10);
  const from = Math.max(0, target - 4), to = Math.min(lines.length, target + 3);
  return lines.slice(from, to)
    .map((l, i) => `${String(from + i + 1).padStart(4)} | ${l}`)
    .join('\n');
}

export function createProgram(gl, vsSource, fsSource, label = 'shader') {
  const vs = compileStage(gl, gl.VERTEX_SHADER, vsSource, `${label} (vertex)`);
  const fs = compileStage(gl, gl.FRAGMENT_SHADER, fsSource, `${label} (fragment)`);
  const prog = gl.createProgram();
  gl.attachShader(prog, vs);
  gl.attachShader(prog, fs);
  gl.linkProgram(prog);
  gl.deleteShader(vs);
  gl.deleteShader(fs);
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
    const log = gl.getProgramInfoLog(prog);
    gl.deleteProgram(prog);
    throw new Error(`${label} failed to link:\n${log}`);
  }

  // Cache uniform locations up front; looking them up per frame is a real cost
  // once there are dozens of them.
  const uniforms = {};
  const count = gl.getProgramParameter(prog, gl.ACTIVE_UNIFORMS);
  for (let i = 0; i < count; i++) {
    const info = gl.getActiveUniform(prog, i);
    if (!info) continue;
    const name = info.name.replace(/\[0\]$/, '');
    uniforms[name] = gl.getUniformLocation(prog, name);
  }

  return { program: prog, uniforms };
}

// ---------------------------------------------------------------- quad

export function createQuad(gl) {
  const vao = gl.createVertexArray();
  const buf = gl.createBuffer();
  gl.bindVertexArray(vao);
  gl.bindBuffer(gl.ARRAY_BUFFER, buf);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
  gl.enableVertexAttribArray(0);
  gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
  gl.bindVertexArray(null);

  return {
    // One oversized triangle rather than two triangles: no diagonal seam and one
    // fewer vertex per draw.
    draw() {
      gl.bindVertexArray(vao);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      gl.bindVertexArray(null);
    },
    dispose() {
      gl.deleteVertexArray(vao);
      gl.deleteBuffer(buf);
    },
  };
}

// ---------------------------------------------------------------- targets

export class RenderTarget {
  constructor(gl, width, height, { float = false, depth = false } = {}) {
    this.gl = gl;
    this.width = width;
    this.height = height;
    this.float = float;
    this.hasDepth = depth;

    this.texture = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, this.texture);
    gl.texImage2D(gl.TEXTURE_2D, 0, float ? gl.RGBA16F : gl.RGBA8,
      width, height, 0, gl.RGBA, float ? gl.HALF_FLOAT : gl.UNSIGNED_BYTE, null);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

    this.fbo = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.texture, 0);

    if (depth) {
      this.depthBuffer = gl.createRenderbuffer();
      gl.bindRenderbuffer(gl.RENDERBUFFER, this.depthBuffer);
      gl.renderbufferStorage(gl.RENDERBUFFER, gl.DEPTH_COMPONENT24, width, height);
      gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.RENDERBUFFER, this.depthBuffer);
    }

    const status = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    if (status !== gl.FRAMEBUFFER_COMPLETE)
      throw new Error(`render target incomplete (0x${status.toString(16)}) at ${width}x${height}`);
  }

  bind() {
    const gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbo);
    gl.viewport(0, 0, this.width, this.height);
  }

  clear(r = 0, g = 0, b = 0, a = 1) {
    const gl = this.gl;
    gl.clearColor(r, g, b, a);
    gl.clear(gl.COLOR_BUFFER_BIT | (this.hasDepth ? gl.DEPTH_BUFFER_BIT : 0));
  }

  dispose() {
    const gl = this.gl;
    gl.deleteTexture(this.texture);
    gl.deleteFramebuffer(this.fbo);
    if (this.depthBuffer) gl.deleteRenderbuffer(this.depthBuffer);
  }
}

/** Two targets swapped each pass, so a shader can read what the last one wrote. */
export class PingPong {
  constructor(gl, width, height, opts) {
    this.a = new RenderTarget(gl, width, height, opts);
    this.b = new RenderTarget(gl, width, height, opts);
  }
  get read() { return this.a; }
  get write() { return this.b; }
  swap() { const t = this.a; this.a = this.b; this.b = t; }
  dispose() { this.a.dispose(); this.b.dispose(); }
}

/** Bind a texture to a unit and point a sampler uniform at it. */
export function bindTexture(gl, location, texture, unit) {
  if (location == null) return;
  gl.activeTexture(gl.TEXTURE0 + unit);
  gl.bindTexture(gl.TEXTURE_2D, texture);
  gl.uniform1i(location, unit);
}
