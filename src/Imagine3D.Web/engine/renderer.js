// The compositor. Given a time t it produces one finished frame:
//
//   scene  ->  [transition with the outgoing scene]  ->  post stack
//          ->  LTX blend  ->  text  ->  output
//
// Preview and final render call exactly the same renderAt(), so what you scrub is
// what gets encoded.

import {
  createGL, createQuad, describeRenderer, RenderTarget, PingPong, bindTexture,
  VERTEX_SHADER, UNIFORM_PREAMBLE, createProgram, resolveIncludes,
} from './gl.js';
import { EffectRegistry, compileSceneParams, evalParams } from './registry.js';
import { Modulation } from './modulation.js';
import { getPalette } from './palettes.js';
import { TextLayer } from './textlayer.js';
import { compileExpr } from './expr.js';

/** Order must match blendMode() in shaders/blend.glsl. */
export const BLEND_MODES = [
  'normal', 'add', 'multiply', 'screen', 'difference', 'overlay', 'xor',
  'subtract', 'lighten', 'darken', 'dodge', 'burn', 'softlight', 'and', 'or',
];

const COPY_FRAG = `${UNIFORM_PREAMBLE}
void main() { fragColor = vec4(texture(uPrev, vUv).rgb, 1.0); }`;

export class Renderer {
  constructor(canvas, width, height) {
    this.canvas = canvas;
    this.width = width;
    this.height = height;
    canvas.width = width;
    canvas.height = height;

    this.gl = createGL(canvas);
    this.info = describeRenderer(this.gl);
    this.quad = createQuad(this.gl);

    const gl = this.gl;
    this.sceneA = new RenderTarget(gl, width, height, { depth: true });
    this.sceneB = new RenderTarget(gl, width, height, { depth: true });
    this.post = new PingPong(gl, width, height);
    this.feedback = new RenderTarget(gl, width, height);
    this.output = new RenderTarget(gl, width, height);

    this.copy = createProgram(gl, VERTEX_SHADER, COPY_FRAG, 'copy');

    this.text = new TextLayer(gl, width, height);
    this.blank = this.makeBlankTexture();

    this.registry = null;
    this.storyboard = null;
    this.mod = null;
    this.palette = getPalette('frost');
    this.seed = 0;
    this.scenePrograms = new Map();
    this.videos = new Map();
    this.warnings = [];
    this.pixelBuffer = new Uint8Array(width * height * 4);
  }

  makeBlankTexture() {
    const gl = this.gl;
    const tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE,
      new Uint8Array([0, 0, 0, 255]));
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    return tex;
  }

  /** Load the analysis + storyboard and warm up every effect they reference. */
  async load(analysis, storyboard, mediaBase) {
    this.analysis = analysis;
    this.storyboard = storyboard;
    this.mod = new Modulation(analysis);
    this.palette = getPalette(storyboard.palette);
    this.seed = (storyboard.seed ?? 1) * 0.618;
    this.mediaBase = mediaBase;
    this.registry = await EffectRegistry.load();
    this.warnings = [];

    const ctx = {
      gl: this.gl, quad: this.quad,
      width: this.width, height: this.height,
      // Mesh scenes use the seed to pick which library asset they show, so the
      // same project always gets the same models.
      seed: storyboard.seed ?? 1,
      palette: this.palette,
    };

    // Instantiate everything up front. Compiling a shader mid-render would stall
    // the frame loop for hundreds of milliseconds at an unpredictable moment.
    const wanted = new Set();
    for (const scene of storyboard.scenes) {
      wanted.add(scene.effectId);
      if (scene.transitionIn) wanted.add(scene.transitionIn);
      for (const p of scene.post ?? []) wanted.add(p.effectId);
    }
    wanted.add('textcomposite');
    wanted.add('videoblend');
    wanted.add('sceneblend');

    for (const id of wanted) {
      if (!this.registry.get(id)) {
        this.warnings.push(`storyboard references unknown effect "${id}" - skipping it`);
        continue;
      }
      try {
        await this.registry.instance(this.gl, id, ctx);
      } catch (err) {
        // A single broken effect degrades that scene, it does not fail the video.
        this.warnings.push(err.message);
      }
    }

    // Pre-compile every scene's parameter expressions.
    this.compiled = new Map();
    for (const scene of storyboard.scenes) {
      const manifest = this.registry.get(scene.effectId);
      if (manifest) this.compiled.set(`s${scene.index}`, compileSceneParams(manifest, scene.params));
      if (scene.blend?.amount) {
        this.compiled.set(`b${scene.index}`, { __amount: compileExpr(scene.blend.amount) });
      }
      (scene.post ?? []).forEach((p, i) => {
        const pm = this.registry.get(p.effectId);
        if (pm) {
          this.compiled.set(`s${scene.index}p${i}`, compileSceneParams(pm, p.params));
          this.compiled.set(`s${scene.index}a${i}`, { __amount: compileExpr(p.amount) });
        }
      });
    }

    for (const insert of storyboard.ltx ?? []) {
      this.compiled.set(`ltx${insert.index}`, { __opacity: compileExpr(insert.opacity) });
    }

    // The utility passes take their parameters straight from the manifest
    // defaults; they have no storyboard entry to override them.
    for (const id of ['textcomposite', 'videoblend']) {
      const m = this.registry.get(id);
      if (m) this.compiled.set(`util:${id}`, compileSceneParams(m, null));
    }

    await this.loadVideos(storyboard.ltx ?? []);
    return this.warnings;
  }

  /**
   * LTX clips are <video> elements used as textures. They must be seekable and
   * decoded frame-accurately, so the render loop drives currentTime explicitly
   * rather than letting them play.
   */
  async loadVideos(inserts) {
    for (const insert of inserts) {
      const el = document.createElement('video');
      el.src = `${this.mediaBase}/ltx/${insert.clipFile}`;
      el.muted = true;
      el.playsInline = true;
      el.preload = 'auto';
      el.crossOrigin = 'anonymous';

      const gl = this.gl;
      const tex = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE,
        new Uint8Array([0, 0, 0, 255]));
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

      try {
        await new Promise((resolve, reject) => {
          el.onloadeddata = resolve;
          el.onerror = () => reject(new Error(`could not load LTX clip ${insert.clipFile}`));
          setTimeout(() => reject(new Error(`timed out loading ${insert.clipFile}`)), 20000);
        });
        this.videos.set(insert.index, { el, tex, insert });
      } catch (err) {
        this.warnings.push(err.message);
      }
    }
  }

  sceneAt(t) {
    const scenes = this.storyboard.scenes;
    if (!scenes.length) return null;
    let lo = 0, hi = scenes.length - 1, best = 0;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (scenes[mid].start <= t) { best = mid; lo = mid + 1; } else hi = mid - 1;
    }
    return scenes[best];
  }

  baseState(t, scene, extra) {
    return {
      width: this.width,
      height: this.height,
      mod: this.mod.at(t, scene, extra),
      palette: this.palette,
      seed: this.seed,
      amount: 1,
      blendMode: 0,
    };
  }

  /** Draw an effect into a target. Missing/broken effects clear to black. */
  drawEffect(id, target, state, params, textures) {
    const inst = this.registry.instances.get(id);
    target.bind();
    if (!inst) { target.clear(); return false; }
    if (inst.kind === 'scene3d') this.gl.enable(this.gl.DEPTH_TEST);
    else this.gl.disable(this.gl.DEPTH_TEST);
    inst.render(state, params, textures, this.quad);
    return true;
  }

  textures(overrides = {}) {
    return {
      prev: this.blank,
      next: this.blank,
      feedback: this.feedback.texture,
      video: this.blank,
      text: this.text.texture,
      videoAmount: 0,
      ...overrides,
    };
  }

  /** Render one finished frame for time t into this.output. */
  renderAt(t) {
    const gl = this.gl;
    const scene = this.sceneAt(t);
    if (!scene) { this.output.bind(); this.output.clear(); return; }

    // --- 1. current scene ---------------------------------------------------
    const state = this.baseState(t, scene);
    const params = evalParams(this.compiled.get(`s${scene.index}`) ?? {}, state.mod);
    this.drawEffect(scene.effectId, this.sceneA, state, params, this.textures());

    const intoScene = t - scene.start;
    const prevScene = scene.index > 0 ? this.storyboard.scenes[scene.index - 1] : null;

    // --- 2a. sustained blend with the outgoing scene ------------------------
    //
    // A scene can be layered over the previous one instead of replacing it at a
    // cut. The underlying scene keeps being drawn for `duration` seconds (0 =
    // the whole scene), and the mix ramps in and out over `fade` so it never
    // pops in or snaps off.
    const blend = scene.blend;
    let blended = false;
    if (prevScene && blend) {
      const span = blend.duration > 0 ? blend.duration : scene.end - scene.start;
      if (intoScene < span) {
        const fade = Math.max(0.001, blend.fade ?? 0.5);
        const envelope = Math.min(1,
          Math.min(intoScene / fade, (span - intoScene) / fade));

        if (envelope > 0.002) {
          const pState = this.baseState(t, prevScene);
          const pParams = evalParams(this.compiled.get(`s${prevScene.index}`) ?? {}, pState.mod);
          this.drawEffect(prevScene.effectId, this.sceneB, pState, pParams, this.textures());

          const amountFn = this.compiled.get(`b${scene.index}`)?.__amount;
          const raw = amountFn ? amountFn(state.mod) : 0.6;

          const bState = { ...state };
          bState.amount = Math.max(0, Math.min(1, raw)) * envelope;
          bState.blendMode = Math.max(0, BLEND_MODES.indexOf(blend.mode ?? 'screen'));

          this.drawEffect('sceneblend', this.post.write, bState, {},
            this.textures({ prev: this.sceneB.texture, next: this.sceneA.texture }));
          this.post.swap();
          this.blit(this.post.read, this.sceneA);
          blended = true;
        }
      }
    }

    // --- 2b. transition from the outgoing scene -----------------------------
    // Skipped while a blend is doing the work, or the two would fight.
    if (!blended && prevScene && scene.transitionIn && scene.transitionDuration > 0 &&
        intoScene < scene.transitionDuration) {
      const pState = this.baseState(t, prevScene);
      const pParams = evalParams(this.compiled.get(`s${prevScene.index}`) ?? {}, pState.mod);
      this.drawEffect(prevScene.effectId, this.sceneB, pState, pParams, this.textures());

      const k = Math.min(1, intoScene / scene.transitionDuration);
      const tState = { ...state, amount: k };
      this.drawEffect(scene.transitionIn, this.post.write, tState, {},
        this.textures({ prev: this.sceneB.texture, next: this.sceneA.texture }));
      this.post.swap();
      this.blit(this.post.read, this.sceneA);
    }

    // --- 3. post stack ------------------------------------------------------
    let current = this.sceneA;
    for (let i = 0; i < (scene.post ?? []).length; i++) {
      const p = scene.post[i];
      if (!this.registry.instances.get(p.effectId)) continue;

      const amountFn = this.compiled.get(`s${scene.index}a${i}`)?.__amount;
      const pState = { ...state, amount: amountFn ? amountFn(state.mod) : 1 };
      const pParams = evalParams(this.compiled.get(`s${scene.index}p${i}`) ?? {}, state.mod);

      this.drawEffect(p.effectId, this.post.write, pState, pParams,
        this.textures({ prev: current.texture }));
      this.post.swap();
      current = this.post.read;
    }

    // --- 4. LTX blend -------------------------------------------------------
    const insert = this.activeInsert(t);
    if (insert) {
      const v = this.videos.get(insert.index);
      if (v) {
        this.uploadVideoFrame(v, t - insert.start);
        const clipT = (t - insert.start) / Math.max(1e-6, insert.duration);
        const vState = this.baseState(t, scene, { clipT });
        const opacityFn = this.compiled.get(`ltx${insert.index}`)?.__opacity;
        vState.amount = opacityFn ? Math.max(0, Math.min(1, opacityFn(vState.mod))) : 0.6;
        vState.blendMode = Math.max(0, BLEND_MODES.indexOf(insert.blend));

        const vParams = evalParams(this.compiled.get('util:videoblend') ?? {}, vState.mod);
        this.drawEffect('videoblend', this.post.write, vState, vParams,
          this.textures({ prev: current.texture, video: v.tex }));
        this.post.swap();
        current = this.post.read;
      }
    }

    // --- 5. text ------------------------------------------------------------
    const cue = this.text.update(this.storyboard.texts ?? [], t);
    if (cue) {
      const cueT = (t - cue.start) / Math.max(1e-6, cue.end - cue.start);
      const tState = this.baseState(t, scene, { cueT, style: 0 });
      tState.amount = STYLE_INDEX[cue.style] ?? 0;
      const textParams = evalParams(this.compiled.get('util:textcomposite') ?? {}, tState.mod);
      this.drawEffect('textcomposite', this.post.write, tState, textParams,
        this.textures({ prev: current.texture, text: this.text.texture }));
      this.post.swap();
      current = this.post.read;
    }

    // --- 6. output + feedback ----------------------------------------------
    this.blit(current, this.output);
    // Feedback must be the finished frame, so trails include post and text.
    this.blit(current, this.feedback);

    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  }

  activeInsert(t) {
    for (const insert of this.storyboard.ltx ?? [])
      if (t >= insert.start && t < insert.start + insert.duration) return insert;
    return null;
  }

  /**
   * Seek the clip to the exact offset this frame needs. Offline rendering cannot
   * rely on playback rate - the render is not running in real time.
   */
  uploadVideoFrame(v, offset) {
    const gl = this.gl;
    const want = Math.max(0, Math.min(v.el.duration || offset, offset));
    if (Math.abs(v.el.currentTime - want) > 0.02) v.el.currentTime = want;
    if (v.el.readyState >= 2) {
      gl.bindTexture(gl.TEXTURE_2D, v.tex);
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, v.el);
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    }
  }

  blit(from, to) {
    const gl = this.gl;
    to.bind();
    gl.disable(gl.DEPTH_TEST);
    gl.useProgram(this.copy.program);
    bindTexture(gl, this.copy.uniforms.uPrev, from.texture, 0);
    this.quad.draw();
  }

  /** Copy the finished frame to the visible canvas (preview only). */
  present() {
    const gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, this.width, this.height);
    gl.disable(gl.DEPTH_TEST);
    gl.useProgram(this.copy.program);
    bindTexture(gl, this.copy.uniforms.uPrev, this.output.texture, 0);
    this.quad.draw();
  }

  /** Read the finished frame as RGBA. Rows come back bottom-up; ffmpeg vflips. */
  readPixels() {
    const gl = this.gl;
    this.output.bind();
    gl.readPixels(0, 0, this.width, this.height, gl.RGBA, gl.UNSIGNED_BYTE, this.pixelBuffer);
    return this.pixelBuffer;
  }

  dispose() {
    this.registry?.dispose();
    this.quad.dispose();
    this.sceneA.dispose();
    this.sceneB.dispose();
    this.post.dispose();
    this.feedback.dispose();
    this.output.dispose();
    this.text.dispose();
    for (const v of this.videos.values()) {
      this.gl.deleteTexture(v.tex);
      v.el.src = '';
    }
    this.videos.clear();
  }
}

const STYLE_INDEX = { wave: 0, slam: 1, fade: 2, scroll: 3 };
