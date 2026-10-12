// The compositor. Given a time t it produces one finished frame:
//
//   scene -> [project image] -> its own post stack  ->  [transition with the
//                                     outgoing scene, graded the same way]
//         ->  LTX blend  ->  text  ->  output
//
// Each scene is graded before the two are mixed, not after. See
// renderSceneWithPost() for why that order is the one that matters.
//
// Preview and final render call exactly the same renderAt(), so what you scrub is
// what gets encoded.

import {
  createGL, createQuad, describeRenderer, RenderTarget, PingPong, bindTexture,
  VERTEX_SHADER, UNIFORM_PREAMBLE, createProgram, resolveIncludes,
} from './gl.js';
import { EffectRegistry, compileSceneParams, evalParams } from './registry.js';
import { effectiveScenes } from './timing.js';
import { Modulation } from './modulation.js';
import { getPalette } from './palettes.js';
import { TextLayer } from './textlayer.js';
import { compileExpr } from './expr.js';

/** Order must match blendMode() in shaders/blend.glsl. */
export const BLEND_MODES = [
  'normal', 'add', 'multiply', 'screen', 'difference', 'overlay', 'xor',
  'subtract', 'lighten', 'darken', 'dodge', 'burn', 'softlight', 'and', 'or',
];

/** Order must match the IMG_* constants in shaders/image.glsl. */
export const IMAGE_TREATMENTS = [
  'ripple', 'wave', 'swirl', 'kaleido', 'tunnel', 'slice', 'mosaic', 'bulge',
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
    this.images = new Map();
    // Clips that timed out seeking, so the warning is reported once per clip
    // rather than once per frame.
    this.stuckClips = new Set();
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
    this.storyboard = { ...storyboard, scenes: effectiveScenes(storyboard) };
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
    if (storyboard.images?.length) wanted.add('imagelayer');

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

    const imageLayer = this.registry.get('imagelayer');
    for (const cue of storyboard.images ?? []) {
      if (!imageLayer) break;
      this.compiled.set(`img${cue.index}`, compileSceneParams(imageLayer, cue.params));
      this.compiled.set(`imga${cue.index}`, { __opacity: compileExpr(cue.opacity) });
    }

    // The utility passes take their parameters straight from the manifest
    // defaults; they have no storyboard entry to override them.
    for (const id of ['textcomposite', 'videoblend']) {
      const m = this.registry.get(id);
      if (m) this.compiled.set(`util:${id}`, compileSceneParams(m, null));
    }

    await this.loadImages(storyboard.images ?? []);
    await this.loadVideos(storyboard.ltx ?? []);
    return this.warnings;
  }

  /**
   * Upload every image the plan names, once each however many cues use it.
   *
   * Mipmapped, unlike the LTX clips: a photograph is typically several times the
   * output width and the cues zoom and drift through it, so a straight LINEAR
   * minification aliases on every edge in the picture - which on a slow push
   * reads as the image crawling.
   */
  async loadImages(cues) {
    const gl = this.gl;
    for (const file of new Set(cues.map((c) => c.file))) {
      const img = new Image();
      img.src = `${this.mediaBase}/images/${encodeURIComponent(file)}`;

      try {
        await img.decode();
      } catch {
        // A missing or unreadable image costs its cues, not the video - the same
        // as an effect the plan names that is no longer in the library.
        this.warnings.push(`could not load image "${file}" - the scenes using it render without it`);
        continue;
      }

      const tex = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, img);
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
      gl.generateMipmap(gl.TEXTURE_2D);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

      this.images.set(file, {
        tex,
        aspect: (img.naturalWidth || 1) / Math.max(1, img.naturalHeight),
      });
    }
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
      image: this.blank,
      imageAspect: 1,
      // Any effect may sample uImage; this is how it knows whether there is
      // anything there. Without it an effect built around a picture renders a
      // black frame wherever it is drawn with no cue running - the gallery, the
      // contact sheet, the probe - and a black frame is exactly the failure
      // nobody notices until it is in a video.
      hasImage: 0,
      videoAmount: 0,
      ...overrides,
    };
  }

  /** The cue running on this scene at time t, or null. */
  imageCue(scene, t) {
    const cues = this.storyboard.images;
    if (!cues?.length) return null;

    // Clamped into the scene's own span. While a transition or a blend runs, the
    // outgoing scene is drawn at a time past its own end - an unclamped lookup
    // drops its image on the first frame of the edit, which is a pop *before*
    // the transition rather than during it. Same reasoning as grading each scene
    // separately; see renderSceneWithPost.
    const tt = Math.min(Math.max(t, scene.sourceStart ?? scene.start), scene.sourceEnd ?? scene.end);
    for (const c of cues)
      if (c.sceneIndex === scene.index && tt >= c.start && tt <= c.end) return c;
    return null;
  }

  /**
   * What the cue's image should be bound as, plus the evaluated pass state.
   * Returns null when the cue names an image that could not be loaded.
   */
  imageTextures(cue, scene, t) {
    const img = this.images.get(cue.file);
    if (!img) return null;

    const tt = Math.min(Math.max(t, scene.sourceStart ?? scene.start), scene.sourceEnd ?? scene.end);
    const imageT = Math.min(1, Math.max(0, (tt - cue.start) / Math.max(1e-6, cue.end - cue.start)));
    return { img, imageT };
  }

  /**
   * Draw a scene into `target` and run *its own* post stack over it, leaving the
   * finished shot in `target`.
   *
   * A scene's post stack belongs to that scene, not to the moment. This used to
   * run once, after the transition, over whatever mix of the two scenes was on
   * screen - so at the instant a transition began, the outgoing scene was handed
   * the incoming scene's grade. Across the plans in this repo 95% of boundaries
   * have a different stack on each side, which meant almost every cut opened
   * with the old scene's pixelation, bloom or CRT snapping off in one frame,
   * before the transition had moved at all. A two-second dissolve cannot hide
   * that, because it happens before the dissolve starts.
   *
   * Grading each shot and then dissolving between the graded shots is both the
   * correct order and the cheaper mistake to make: it costs one extra post chain
   * while a transition is running, and nothing the rest of the time.
   *
   * A project image belongs to this chain for the same reason. It goes in right
   * after the scene draws and before the grade, so the photo is pixelated by the
   * scene's pixelate and bent by its CRT, and it arrives and leaves through the
   * scene's own transition. Composited after all that it reads as a sticker.
   */
  renderSceneWithPost(scene, t, target) {
    // The cue is bound for every pass in this chain, not just the imagelayer -
    // any effect that samples a texture may sample the picture, so a scene
    // effect or a post pass that declares it uses one simply gets it.
    const cue = this.imageCue(scene, t);
    const bound = cue ? this.imageTextures(cue, scene, t) : null;
    const withImage = bound
      ? { image: bound.img.tex, imageAspect: bound.img.aspect, hasImage: 1 }
      : {};

    // Always set, never left over: the modulation object is reused frame to
    // frame, so a scene with no cue would otherwise inherit the last one's clock.
    const state = this.baseState(t, scene, { imageT: bound ? bound.imageT : 0 });

    const params = evalParams(this.compiled.get(`s${scene.index}`) ?? {}, state.mod);
    this.drawEffect(scene.effectId, target, state, params, this.textures(withImage));

    let current = target;

    // "effect" placement means the scene is drawing the picture itself, so there
    // is nothing to composite - laying it behind or over as well would put the
    // same image on screen twice.
    if (bound && cue.placement !== 'effect') {
      const iState = { ...state };
      const opacityFn = this.compiled.get(`imga${cue.index}`)?.__opacity;
      iState.amount = Math.max(0, Math.min(1, opacityFn ? opacityFn(state.mod) : 0.6));
      iState.blendMode = Math.max(0, BLEND_MODES.indexOf(cue.blend ?? 'screen'));

      if (iState.amount > 0.002 && this.registry.instances.get('imagelayer')) {
        const iParams = evalParams(this.compiled.get(`img${cue.index}`) ?? {}, state.mod);
        // Placement and treatment are properties of the cue rather than
        // expressions over the music, so the shader is told about them here
        // instead of through params. Named in the storyboard, indices in GLSL.
        iParams.behind = cue.placement === 'behind' ? 1 : 0;
        iParams.treatment = Math.max(0, IMAGE_TREATMENTS.indexOf(cue.treatment));

        this.drawEffect('imagelayer', this.post.write, iState, iParams,
          this.textures({ ...withImage, prev: current.texture }));
        this.post.swap();
        current = this.post.read;
      }
    }

    for (let i = 0; i < (scene.post ?? []).length; i++) {
      const p = scene.post[i];
      if (!this.registry.instances.get(p.effectId)) continue;

      const amountFn = this.compiled.get(`s${scene.index}a${i}`)?.__amount;
      const amount = Math.max(0, Math.min(1, amountFn ? amountFn(state.mod) : 1));
      if (amount === 0) continue;
      const pState = { ...state, amount };
      const pParams = evalParams(this.compiled.get(`s${scene.index}p${i}`) ?? {}, state.mod);

      this.drawEffect(p.effectId, this.post.write, pState, pParams,
        this.textures({ ...withImage, prev: current.texture }));
      this.post.swap();
      current = this.post.read;
    }

    // Park the result back in the scene's own target, so the ping-pong is free
    // for the other scene's stack.
    if (current !== target) this.blit(current, target);
    return state;
  }

  /** Render one finished frame for time t into this.output. */
  renderAt(t) {
    const gl = this.gl;
    const scene = this.sceneAt(t);
    if (!scene) { this.output.bind(); this.output.clear(); return; }

    // --- 1. current scene, graded -------------------------------------------
    const state = this.renderSceneWithPost(scene, t, this.sceneA);
    let current = this.sceneA;

    const intoScene = t - scene.start;
    const prevScene = scene.index > 0 ? this.storyboard.scenes[scene.index - 1] : null;

    // --- 2a. sustained blend with the outgoing scene ------------------------
    //
    // A scene can be layered over the previous one instead of replacing it at a
    // cut. The underlying scene keeps being drawn for `duration` seconds (0 =
    // the whole scene), and the mix ramps in and out over `fade` so it never
    // pops in or snaps off.
    //
    // The blend *is* the boundary - the director sets transitionDuration to 0
    // whenever it picks one - so this pass has to carry the crossfade as well as
    // the layer. `reveal` does that: it decides which scene the frame settles on
    // underneath the layer, and it starts at 0. At intoScene = 0 the layer is
    // also 0, so the first frame of a blended scene is precisely the last frame
    // of the one before it, and the new scene arrives by being mixed in.
    //
    // Without it the envelope alone left the frame showing the incoming scene
    // raw at the cut and then swelled the outgoing one back over the top of it -
    // a hard cut followed by a ghost, which is the opposite of flowing.
    const blend = scene.blend;
    let blended = false;
    if (prevScene && blend) {
      const span = blend.duration > 0 ? blend.duration : scene.end - scene.start;
      if (intoScene < span) {
        // A ramp longer than half the span could never finish, so the reveal
        // would still be mid-crossfade when the layer was already leaving.
        const fade = Math.min(Math.max(0.001, blend.fade ?? 0.5), span * 0.45);
        const k = Math.min(1, intoScene / fade);
        const reveal = k * k * (3 - 2 * k);
        const envelope = Math.min(1,
          Math.min(intoScene / fade, (span - intoScene) / fade));

        // Run it whenever either knob is doing something. Skipping on a zero
        // envelope alone would skip exactly the frames where the reveal is
        // holding the outgoing scene on screen.
        if (envelope > 0.002 || reveal < 0.998) {
          this.renderSceneWithPost(prevScene, t, this.sceneB);

          const amountFn = this.compiled.get(`b${scene.index}`)?.__amount;
          const raw = amountFn ? amountFn(state.mod) : 0.6;

          const bState = { ...state };
          bState.amount = Math.max(0, Math.min(1, raw)) * envelope;
          bState.blendMode = Math.max(0, BLEND_MODES.indexOf(blend.mode ?? 'screen'));

          this.drawEffect('sceneblend', this.post.write, bState, { reveal },
            this.textures({ prev: this.sceneB.texture, next: this.sceneA.texture }));
          this.post.swap();
          current = this.post.read;
          blended = true;
        }
      }
    }

    // --- 2b. transition from the outgoing scene -----------------------------
    // Skipped while a blend is doing the work, or the two would fight.
    if (!blended && scene.transitionIn && scene.transitionDuration > 0 &&
        intoScene < scene.transitionDuration) {
      // The first scene has nothing to come from, so it is transitioned out of
      // black rather than being skipped: otherwise the video opens on a frame
      // already at full brightness, which is the one cut in the whole render
      // that nothing at all leads into.
      let outgoing = this.blank;
      if (prevScene) {
        this.renderSceneWithPost(prevScene, t, this.sceneB);
        outgoing = this.sceneB.texture;
      }

      const k = Math.min(1, intoScene / scene.transitionDuration);
      const tState = { ...state, amount: k };
      this.drawEffect(scene.transitionIn, this.post.write, tState, {},
        this.textures({ prev: outgoing, next: this.sceneA.texture }));
      this.post.swap();
      current = this.post.read;
    }

    // --- 3. LTX blend -------------------------------------------------------
    const insert = this.activeInsert(t);
    if (insert) {
      const v = this.videos.get(insert.index);
      if (v) {
        this.uploadVideoFrame(v);
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

    // --- 4. text ------------------------------------------------------------
    const cue = this.text.update(this.storyboard.texts ?? [], t);
    if (cue) {
      const cueT = (t - cue.start) / Math.max(1e-6, cue.end - cue.start);
      const style = STYLE_INDEX[cue.style] ?? 0;
      // Where the line is in the bar as well as in itself. A style that steps
      // through the words one per beat needs to be told what a beat is, and it
      // has to be the tracked grid rather than 60/bpm or the words come off the
      // beat the moment the tempo moves at all.
      const tState = this.baseState(t, scene, {
        cueT,
        style,
        cueBeats: this.mod.beatsBetween(cue.start, t),
        cueSpan: this.mod.beatsBetween(cue.start, cue.end),
        cueIds: 1,
        // Song time, not the scene-relative clock every other pass runs on (see
        // Modulation.at). A line is often still on screen when the scene under
        // it cuts, and the text is the one thing that did not change across that
        // edit - restarting its clock would jump the colour cycle and the wave
        // in the middle of a word. Nothing in this pass multiplies time by a
        // music-driven rate, so it has none of the drift that made the scene
        // clock necessary in the first place.
        t: t * this.mod.pace,
      });
      tState.amount = style;
      const textParams = evalParams(this.compiled.get('util:textcomposite') ?? {}, tState.mod);
      this.drawEffect('textcomposite', this.post.write, tState, textParams,
        this.textures({ prev: current.texture, text: this.text.texture }));
      this.post.swap();
      current = this.post.read;
    }

    // --- 5. output + feedback ----------------------------------------------
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

  /** Where in the clip time t falls, clamped to a position that has a frame. */
  clipOffset(v, insert, t) {
    // Stay a hair inside the clip. LTX returns 4.83s for a 5s request, and
    // seeking to exactly `duration` does not reliably produce a frame.
    const end = Math.max(0, (v.el.duration || insert.duration) - 1 / 60);
    return Math.max(0, Math.min(end, t - insert.start));
  }

  /**
   * Put the clip this frame needs on the right frame, and wait for it.
   *
   * Must be awaited before renderAt(t) for the same t. Setting `currentTime` is
   * asynchronous - the decoded frame for the new position only exists once
   * `seeked` fires - while renderAt() is synchronous and the offline loop reads
   * pixels the instant it returns. Uploading in that window takes whatever frame
   * the element still held, and because each frame re-seeks 1/fps further on, an
   * in-flight seek is aborted before it can ever deliver. Whenever the render
   * outruns the decoder the texture never leaves its initial black - and black
   * through `screen` or `difference` is exactly the source frame, so the insert
   * silently does nothing. That is the bug this await closes; it is a race, which
   * is why clips appeared on some renders and not others.
   */
  async prepareAt(t) {
    const insert = this.activeInsert(t);
    if (!insert) return;
    const v = this.videos.get(insert.index);
    if (!v) return;

    const el = v.el;
    const want = this.clipOffset(v, insert, t);
    if (el.readyState >= 2 && Math.abs(el.currentTime - want) <= 0.02) return;

    await new Promise((resolve) => {
      let settled = false;
      const done = () => {
        if (settled) return;
        settled = true;
        el.removeEventListener('seeked', done);
        clearTimeout(timer);
        resolve();
      };
      // A clip that will not seek must cost one frame, not the whole render.
      const timer = setTimeout(() => {
        if (!this.stuckClips.has(insert.index)) {
          this.stuckClips.add(insert.index);
          window.__report?.('warn',
            `LTX clip ${insert.clipFile} did not seek within 3s - it will be missing from the render`);
        }
        done();
      }, 3000);
      el.addEventListener('seeked', done);
      el.currentTime = want;
    });
  }

  /** Upload the clip's current decoded frame. prepareAt() chose which one. */
  uploadVideoFrame(v) {
    const gl = this.gl;
    if (v.el.readyState < 2) return;
    gl.bindTexture(gl.TEXTURE_2D, v.tex);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, v.el);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
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
    // Every run builds a renderer on the same canvas and so the same context;
    // anything left behind here accumulates for the life of the window.
    this.gl.deleteTexture(this.blank);
    this.gl.deleteProgram(this.copy.program);
    for (const v of this.videos.values()) {
      this.gl.deleteTexture(v.tex);
      v.el.src = '';
    }
    this.videos.clear();
    for (const img of this.images.values()) this.gl.deleteTexture(img.tex);
    this.images.clear();
  }
}

/// Storyboard style name -> the index effects/textcomposite switches on. An
/// unknown name falls back to the wavy scroller rather than dropping the line.
const STYLE_INDEX = {
  wave: 0, slam: 1, fade: 2, scroll: 3,
  karaoke: 4, cascade: 5, spectrum: 6, shockwave: 7, drift: 8, shatter: 9,
};
