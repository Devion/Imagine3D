// Renders every registered effect once into a labelled contact sheet.
//
// Writing a large shader library blind is how you end up with thirty plausible
// manifests and a black video. This is the tool that makes each one visible, and
// it runs either from preview.html or on command from the backend.

import {
  createGL, createQuad, RenderTarget, bindTexture,
  VERTEX_SHADER, UNIFORM_PREAMBLE, createProgram,
} from '../engine/gl.js';
import { EffectRegistry, defaultParams } from '../engine/registry.js';
import { compileParams, evalParams } from '../engine/expr.js';
import { getPalette } from '../engine/palettes.js';

const CELL_W = 320, CELL_H = 180, COLS = 5, LABEL = 26;

/** A synthetic "mid-song, beat just landed" state so effects show themselves driven. */
function fakeMod(t) {
  return {
    t, sceneT: 0.4, sectionT: 0.4, cueT: 0.5, clipT: 0.5,
    beat: 0.15, beatPulse: 0.8, bar: 0.3, barPulse: 0.6, phrase: 0.25, beatStrength: 0.85,
    onset: 0.5, rms: 0.6, energy: 0.6, index: 4, rmsPeak: 0.78,
    sub: 0.6, bass: 0.7, lowMid: 0.5, mid: 0.55, high: 0.45, air: 0.4,
    // Peaks sit above their band, as they do a moment after a hit - otherwise a
    // meter's cap would render sitting exactly on top of its bar.
    subPeak: 0.75, bassPeak: 0.88, lowMidPeak: 0.68, midPeak: 0.72,
    highPeak: 0.6, airPeak: 0.52,
    bands: {},
  };
}

function uploadCanvas(gl, canvas) {
  const tex = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, canvas);
  gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  return tex;
}

/** Something for post effects and transitions to operate on. */
function sourceTexture(gl, variant) {
  const c = document.createElement('canvas');
  c.width = CELL_W; c.height = CELL_H;
  const ctx = c.getContext('2d');
  const g = ctx.createLinearGradient(0, 0, CELL_W, CELL_H);
  if (variant) { g.addColorStop(0, '#101c3a'); g.addColorStop(0.5, '#2fa8d0'); g.addColorStop(1, '#f0f8ff'); }
  else { g.addColorStop(0, '#3a1020'); g.addColorStop(0.5, '#e05a20'); g.addColorStop(1, '#ffe0a0'); }
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, CELL_W, CELL_H);
  ctx.fillStyle = 'rgba(0,0,0,0.5)';
  for (let i = 0; i < 20; i++) ctx.fillRect((i * 61 + variant * 37) % CELL_W, (i * 29) % CELL_H, 26, 12);
  ctx.fillStyle = '#fff';
  ctx.font = 'bold 30px sans-serif';
  ctx.fillText(variant ? 'NEXT' : 'PREV', 16, CELL_H - 20);
  return uploadCanvas(gl, c);
}

function textTexture(gl) {
  const c = document.createElement('canvas');
  c.width = CELL_W; c.height = CELL_H;
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#fff';
  ctx.font = 'bold 28px sans-serif';
  ctx.textAlign = 'center';
  ctx.fillText('LYRIC LINE', CELL_W / 2, CELL_H * 0.78);
  return uploadCanvas(gl, c);
}

/**
 * Render the sheet. Returns { canvas, failures, count }.
 * `work` is the offscreen canvas the GL context draws into.
 */
export async function renderContactSheet({ kind = 'all', palette = 'neon', onStatus = () => {} } = {}) {
  const work = document.createElement('canvas');
  work.width = CELL_W;
  work.height = CELL_H;

  const gl = createGL(work);
  const quad = createQuad(gl);
  const target = new RenderTarget(gl, CELL_W, CELL_H, { depth: true });
  const copy = createProgram(gl, VERTEX_SHADER,
    `${UNIFORM_PREAMBLE}\nvoid main(){ fragColor = vec4(texture(uPrev, vUv).rgb, 1.0); }`, 'copy');

  const prevTex = sourceTexture(gl, 0);
  const nextTex = sourceTexture(gl, 1);
  const textTex = textTexture(gl);
  const pal = getPalette(palette);

  const reg = await EffectRegistry.load();
  const manifests = [...reg.manifests.values()]
    .filter((m) => kind === 'all' || m.kind === kind)
    .sort((a, b) => (a.kind + a.id).localeCompare(b.kind + b.id));

  const rows = Math.max(1, Math.ceil(manifests.length / COLS));
  const canvas = document.createElement('canvas');
  canvas.width = COLS * (CELL_W + 8) + 8;
  canvas.height = rows * (CELL_H + LABEL) + 8;
  const sctx = canvas.getContext('2d');
  sctx.fillStyle = '#0b0d12';
  sctx.fillRect(0, 0, canvas.width, canvas.height);

  const failures = [];

  for (let i = 0; i < manifests.length; i++) {
    const m = manifests[i];
    onStatus(`${i + 1}/${manifests.length} ${m.id}`);

    let ok = true;
    try {
      const inst = await reg.instance(gl, m.id, { gl, quad, width: CELL_W, height: CELL_H });
      const mod = fakeMod(6.2);
      const params = evalParams(compileParams(defaultParams(m)), mod);

      const state = {
        width: CELL_W, height: CELL_H, mod, palette: pal, seed: 0.618,
        // Catch a transition mid-sweep; show a post fully applied; textcomposite
        // reads uAmount as its style index, where 0 is the wavy scroller.
        amount: m.kind === 'transition' ? 0.5 : (m.id === 'textcomposite' ? 0 : 1),
        blendMode: 3,
      };

      target.bind();
      target.clear();
      if (m.kind === 'scene3d') gl.enable(gl.DEPTH_TEST); else gl.disable(gl.DEPTH_TEST);

      inst.render(state, params, {
        prev: prevTex, next: nextTex, feedback: prevTex,
        video: nextTex, text: textTex, videoAmount: 1,
        // Effects that draw one of the project's images get the same stand-in
        // the transitions do, so they appear on the sheet rather than as black.
        image: nextTex, imageAspect: CELL_W / CELL_H, hasImage: 1,
      }, quad);

      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.viewport(0, 0, CELL_W, CELL_H);
      gl.disable(gl.DEPTH_TEST);
      gl.useProgram(copy.program);
      bindTexture(gl, copy.uniforms.uPrev, target.texture, 0);
      quad.draw();
    } catch (err) {
      ok = false;
      failures.push(`${m.id}: ${err.message}`);
      console.error(`[sheet] ${m.id}`, err);
    }

    const col = i % COLS, row = Math.floor(i / COLS);
    const x = 8 + col * (CELL_W + 8);
    const y = 8 + row * (CELL_H + LABEL);

    if (ok) sctx.drawImage(work, x, y);
    else { sctx.fillStyle = '#3d1d1d'; sctx.fillRect(x, y, CELL_W, CELL_H); }

    sctx.fillStyle = ok ? '#e6ebf5' : '#ff6b6b';
    sctx.font = '13px "Segoe UI", sans-serif';
    sctx.fillText(`${m.id} (${m.kind})`, x + 2, y + CELL_H + 16);
  }

  return { canvas, failures, count: manifests.length };
}

/** Render and POST the sheet to the backend so it lands on disk for review. */
export async function captureSheetToDisk(opts = {}) {
  const { canvas, failures, count } = await renderContactSheet(opts);
  const blob = await new Promise((r) => canvas.toBlob(r, 'image/png'));
  const name = `sheet-${opts.kind ?? 'all'}-${opts.palette ?? 'neon'}`;
  const res = await fetch(`api/devshot?name=${encodeURIComponent(name)}`, { method: 'POST', body: blob });
  const body = await res.json().catch(() => ({}));
  return { path: body.path, failures, count };
}
