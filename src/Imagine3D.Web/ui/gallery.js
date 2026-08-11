// A playable card per effect.
//
// The contact sheet answers "what does this look like", which is the question a
// still can answer. It cannot answer the one that actually decides whether an
// effect earns a place in the library: what does it *do* - how fast, how hard on
// the beat, does it travel or does it sit there. That needs it running, and
// running against real music rather than a frozen "mid-song" state.
//
// So every card draws from the same clock, and that clock is the song's. Pick a
// project and the analysis behind it drives Modulation exactly as it does in a
// render: the same beat grid, the same band followers, the same peak holds. Press
// play on the audio and the cards are in sync with what you are hearing, because
// both are reading `audio.currentTime`.
//
// One WebGL context for the whole page, not one per card. Ninety contexts is
// past what a browser will give you, and it would be ninety copies of every
// compiled shader. The shared context renders into an offscreen canvas at cell
// size and each playing card copies it out with drawImage, which is a GPU blit.
//
// Cards that are playing but scrolled out of view are skipped rather than
// stopped. An IntersectionObserver is what bounds the cost of "play everything":
// you can only look at a screenful, so only a screenful is ever drawn.

import {
  createGL, createQuad, RenderTarget, bindTexture,
  VERTEX_SHADER, UNIFORM_PREAMBLE, createProgram,
} from '../engine/gl.js';
import { EffectRegistry, defaultParams } from '../engine/registry.js';
import { compileParams, evalParams } from '../engine/expr.js';
import { getPalette, PALETTE_NAMES } from '../engine/palettes.js';
import { Modulation } from '../engine/modulation.js';
import { drawLyricRaster } from '../engine/textlayer.js';

const CELL_W = 320, CELL_H = 180;

/// How long a card's synthetic "scene" lasts, in seconds. Effects that read
/// uSceneT - a morph that runs once through a scene, say - need it to cycle, or
/// a card parked at sceneT = 0.4 shows one frozen point of the morph forever.
const SCENE_SPAN = 24;

/// A transition sweeps 0..1 over this, then holds a moment at each end. Without
/// the hold you cannot see what either side actually looked like.
const WIPE_PERIOD = 3.2;

/// When there is no analysed project to drive from. Not silence - a plain 4/4 at
/// a club tempo, so an effect still shows itself being driven.
const FALLBACK_BPM = 124;

/// textcomposite is ten different treatments behind one uAmount, so its card
/// steps through them: this long on each, and one lyric lifetime per step, so a
/// style that opens or closes on the line is seen doing it.
const LYRIC_STYLES = 10;
const LYRIC_STEP = 4.0;

export class Gallery {
  constructor(root, { onStatus = () => {}, onProgress = null } = {}) {
    this.root = root;
    this.onStatus = onStatus;
    this.onProgress = onProgress;

    this.work = document.createElement('canvas');
    this.work.width = CELL_W;
    this.work.height = CELL_H;

    this.gl = createGL(this.work);
    this.quad = createQuad(this.gl);
    this.target = new RenderTarget(this.gl, CELL_W, CELL_H, { depth: true });
    this.copy = createProgram(this.gl, VERTEX_SHADER,
      `${UNIFORM_PREAMBLE}\nvoid main(){ fragColor = vec4(texture(uPrev, vUv).rgb, 1.0); }`, 'copy');

    this.prevTex = this.gradientTexture(0);
    this.nextTex = this.gradientTexture(1);
    this.textTex = this.textTexture();

    // Effects that draw one of the project's images need a picture to draw. The
    // stand-in is there so they are legible with no project selected; picking one
    // swaps in a real photograph from it, because "what does this effect do" is a
    // different question with a photograph in it than with a test pattern.
    this.stillTex = this.stillTexture();
    this.imageTex = this.stillTex;
    this.imageAspect = CELL_W / CELL_H;

    this.palette = getPalette('neon');
    this.registry = null;
    this.cards = new Map();          // id -> card
    this.playing = new Set();        // ids currently running
    this.visible = new Set();        // ids on screen

    this.mod = null;                 // Modulation, when a project is loaded
    this.analysis = null;
    this.audio = null;
    this.clockBase = 0;              // song time when the wall clock last started
    this.wallBase = performance.now() / 1000;
    this.running = false;

    this.observer = new IntersectionObserver((entries) => {
      for (const e of entries) {
        const id = e.target.dataset.id;
        if (e.isIntersecting) this.visible.add(id); else this.visible.delete(id);
      }
    }, { root: null, rootMargin: '120px' });
  }

  // ---------------------------------------------------------------- textures

  /// `premultiply` matters only for a canvas that has transparency in it - the
  /// lyric raster. See the upload in engine/textlayer.js for why that one cannot
  /// go up any other way.
  uploadCanvas(c, premultiply = false) {
    const gl = this.gl;
    const tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, premultiply);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, c);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    return tex;
  }

  /// Something for post effects and transitions to operate on. Two clearly
  /// different images, so a wipe reads as a wipe rather than as a flicker.
  gradientTexture(variant) {
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
    return this.uploadCanvas(c);
  }

  /// A stand-in photograph: something with a horizon, a subject and detail at
  /// several scales, so an effect that tiles, tears or displaces a picture shows
  /// what it is doing to one.
  stillTexture() {
    const c = document.createElement('canvas');
    c.width = CELL_W; c.height = CELL_H;
    const ctx = c.getContext('2d');

    const sky = ctx.createLinearGradient(0, 0, 0, CELL_H * 0.62);
    sky.addColorStop(0, '#12294f');
    sky.addColorStop(0.6, '#8a5a7a');
    sky.addColorStop(1, '#f0a060');
    ctx.fillStyle = sky;
    ctx.fillRect(0, 0, CELL_W, CELL_H * 0.62);

    ctx.fillStyle = '#ffe9b0';
    ctx.beginPath();
    ctx.arc(CELL_W * 0.68, CELL_H * 0.46, CELL_H * 0.11, 0, Math.PI * 2);
    ctx.fill();

    ctx.fillStyle = '#1a1420';
    ctx.fillRect(0, CELL_H * 0.62, CELL_W, CELL_H * 0.38);
    for (let i = 0; i < 9; i++) {
      const w = 12 + ((i * 37) % 34);
      const h = 18 + ((i * 53) % 46);
      ctx.fillStyle = i % 2 ? '#241c2e' : '#2e2338';
      ctx.fillRect((i * 41) % CELL_W, CELL_H * 0.62 - h, w, h);
    }
    ctx.fillStyle = 'rgba(255,220,160,0.75)';
    for (let i = 0; i < 40; i++)
      ctx.fillRect((i * 29) % CELL_W, CELL_H * 0.62 - 6 - ((i * 17) % 40), 2, 3);

    return this.uploadCanvas(c);
  }

  /// Drawn by the renderer's own rasteriser, ids and all. A plain white sample
  /// line would preview a different shader: half of textcomposite's styles
  /// address the words individually and would fall back to treating the line as
  /// one word - which is exactly the look they were written to replace.
  textTexture() {
    const c = document.createElement('canvas');
    c.width = CELL_W; c.height = CELL_H;
    drawLyricRaster(c.getContext('2d'), 'every word on time', CELL_W, CELL_H);
    return this.uploadCanvas(c, true);
  }

  // ---------------------------------------------------------------- the clock

  /// Song time now. The audio element when it is playing - so the cards and what
  /// you are hearing cannot drift apart - and a wall clock otherwise.
  now() {
    if (this.audio && !this.audio.paused) return this.audio.currentTime;
    return this.clockBase + (performance.now() / 1000 - this.wallBase);
  }

  seek(t) {
    this.clockBase = Math.max(0, t);
    this.wallBase = performance.now() / 1000;
    if (this.audio) this.audio.currentTime = this.clockBase;
  }

  get duration() {
    return this.analysis?.duration ?? 240;
  }

  get bpm() {
    return this.analysis?.bpm ?? FALLBACK_BPM;
  }

  /// Modulation values at song time t.
  ///
  /// With a project loaded this is the real thing - the same object the renderer
  /// builds, reading the same beat grid. Without one it is a plain metronome, so
  /// a card still pulses and you can still tell a beat-driven effect from a
  /// free-running one.
  modAt(t) {
    const start = Math.floor(t / SCENE_SPAN) * SCENE_SPAN;
    if (this.mod) {
      return this.mod.at(t, { start, end: start + SCENE_SPAN }, this.lyricCue(t));
    }

    const period = 60 / FALLBACK_BPM;
    const beat = (t % period) / period;
    const bar = (t % (period * 4)) / (period * 4);
    const pulse = Math.exp(-(beat * period) * 7);
    const swell = 0.5 + 0.5 * Math.sin(t * 0.3);
    return {
      // Scene-relative, exactly as the branch above gets it from Modulation.at.
      // It is the same clock every free-running effect animates against as
      // `uTime * p_speed`, and the reason it restarts is the reason given there:
      // the speed is modulated, and multiplying a moving rate by an unbounded
      // clock turns a wobble in the music into a phase jump the size of t. A
      // card left running on this page ran the clock up for as long as the page
      // was open, and a corridor flight whose speed rides on `energy` was flying
      // backwards inside a minute. Everything else here stays on song time - the
      // beat grid and the band followers are where they are in the song.
      t: t - start,
      sceneT: (t % SCENE_SPAN) / SCENE_SPAN, sectionT: (t % 40) / 40, clipT: 0.5,
      ...this.lyricCue(t),
      beat, bar, phrase: (t % (period * 16)) / (period * 16),
      beatPulse: pulse, barPulse: Math.exp(-(bar * period * 4) * 2.5), beatStrength: 0.85,
      onset: pulse * 0.7, rms: 0.45 + 0.25 * swell, energy: 0.55 + 0.2 * swell, index: 0,
      rmsPeak: 0.75,
      sub: 0.5 + 0.4 * pulse, bass: 0.55 + 0.35 * pulse, lowMid: 0.5 + 0.2 * swell,
      mid: 0.5 + 0.2 * Math.sin(t * 0.9), high: 0.45 + 0.2 * Math.sin(t * 1.7),
      air: 0.4 + 0.2 * Math.sin(t * 2.3),
      subPeak: 0.8, bassPeak: 0.85, lowMidPeak: 0.7, midPeak: 0.68, highPeak: 0.6, airPeak: 0.55,
      bands: {},
    };
  }

  /// The lyric cue the text styles are shown against: one whole line lifetime
  /// per style step, and the line's length in beats so the word-per-beat styles
  /// have a grid to step on rather than sitting at the end of their own timing.
  lyricCue(t) {
    const k = (t % LYRIC_STEP) / LYRIC_STEP;
    const beats = LYRIC_STEP / (60 / this.bpm);
    return { cueT: k, cueBeats: k * beats, cueSpan: beats, cueIds: 1 };
  }

  // ---------------------------------------------------------------- building

  async load(kind = 'all') {
    this.registry = await EffectRegistry.load();
    const manifests = [...this.registry.manifests.values()]
      .filter((m) => kind === 'all' || m.kind === kind)
      .sort((a, b) => (a.kind + a.id).localeCompare(b.kind + b.id));

    this.stopAll();
    this.observer.disconnect();
    this.cards.clear();
    this.visible.clear();
    this.root.replaceChildren();

    for (const m of manifests) this.root.append(this.buildCard(m));
    for (const card of this.cards.values()) this.observer.observe(card.el);

    // One still each, so the page is readable before anything is playing.
    //
    // Instantiated here rather than on first play: compiling a shader takes long
    // enough to be felt, and paying for it when the card is pressed would make
    // every effect seem to stutter on its first frame. Yielding between cards
    // keeps the page responsive while ninety shaders compile.
    let done = 0;
    for (const card of this.cards.values()) {
      await this.ensureInstance(card);
      this.drawCard(card, 6.2);
      if (++done % 8 === 0) {
        this.onProgress?.(done, this.cards.size);
        await new Promise((r) => setTimeout(r, 0));
      }
    }

    return manifests.length;
  }

  buildCard(manifest) {
    const el = document.createElement('figure');
    el.className = 'card';
    el.dataset.id = manifest.id;

    const canvas = document.createElement('canvas');
    canvas.width = CELL_W;
    canvas.height = CELL_H;
    canvas.className = 'shot';

    const play = document.createElement('button');
    play.className = 'play';
    play.type = 'button';
    play.textContent = '▶';
    play.title = 'Play this effect';

    const cap = document.createElement('figcaption');
    const name = document.createElement('span');
    name.className = 'name';
    name.textContent = manifest.id;
    // motion/focus/coverage only mean something for a scene. The manifest record
    // carries defaults for every effect, so printing them on a post pass would
    // be inventing a fact about it.
    const isScene = ['scene2d', 'scene3d', 'raymarch'].includes(manifest.kind);
    const meta = document.createElement('span');
    meta.className = 'meta';
    meta.textContent = isScene
      ? `${manifest.kind} · ${manifest.motion}/${manifest.focus} · cov ${manifest.coverage.toFixed(2)}`
      : manifest.kind;
    cap.append(name, meta);

    const shot = document.createElement('div');
    shot.className = 'shot-wrap';
    shot.append(canvas, play);
    el.append(shot, cap);

    const card = {
      manifest, el, canvas, play,
      ctx: canvas.getContext('2d'),
      compiled: compileParams(defaultParams(manifest)),
      instance: null,
      failed: null,
    };
    this.cards.set(manifest.id, card);

    const toggle = () => this.toggle(manifest.id);
    play.addEventListener('click', toggle);
    canvas.addEventListener('click', toggle);

    return el;
  }

  // ---------------------------------------------------------------- drawing

  async ensureInstance(card) {
    if (card.instance || card.failed) return card.instance;
    try {
      card.instance = await this.registry.instance(this.gl, card.manifest.id, {
        gl: this.gl, quad: this.quad, width: CELL_W, height: CELL_H,
        seed: 1, palette: this.palette,
      });
    } catch (err) {
      card.failed = err.message;
      card.el.classList.add('failed');
      card.play.disabled = true;
      card.ctx.fillStyle = '#3d1d1d';
      card.ctx.fillRect(0, 0, CELL_W, CELL_H);
      card.ctx.fillStyle = '#ff9d9d';
      card.ctx.font = '12px monospace';
      card.ctx.fillText(String(err.message).slice(0, 44), 8, 24);
    }
    return card.instance;
  }

  /// What `amount` means depends on the kind, and getting it wrong makes a whole
  /// class of effect look broken. A transition reads it as its position through
  /// the wipe, so it has to sweep or the card shows one frozen slice. A post
  /// effect reads it as wet/dry. textcomposite reads it as a style index, and
  /// there are ten of them behind that one card, so it steps through them rather
  /// than showing the wavy scroller and implying that is all there is.
  amountFor(manifest, t) {
    if (manifest.kind === 'transition') {
      const k = (t % WIPE_PERIOD) / WIPE_PERIOD;
      // Hold at each end so both sides of the wipe are visible.
      return Math.min(1, Math.max(0, (k - 0.15) / 0.7));
    }
    if (manifest.id === 'textcomposite') return Math.floor(t / LYRIC_STEP) % LYRIC_STYLES;
    return 1;
  }

  drawCard(card, t) {
    if (card.failed) return;
    const gl = this.gl;
    const inst = card.instance;
    if (!inst) return;

    const mod = this.modAt(t);
    const params = evalParams(card.compiled, mod);

    const state = {
      width: CELL_W, height: CELL_H, mod, palette: this.palette, seed: 0.618,
      amount: this.amountFor(card.manifest, t),
      blendMode: 3,
    };

    try {
      this.target.bind();
      this.target.clear();
      if (card.manifest.kind === 'scene3d') gl.enable(gl.DEPTH_TEST);
      else gl.disable(gl.DEPTH_TEST);

      inst.render(state, params, {
        prev: this.prevTex, next: this.nextTex, feedback: this.prevTex,
        video: this.nextTex, text: this.textTex, videoAmount: 1,
        image: this.imageTex, imageAspect: this.imageAspect, hasImage: 1,
      }, this.quad);

      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.viewport(0, 0, CELL_W, CELL_H);
      gl.disable(gl.DEPTH_TEST);
      gl.useProgram(this.copy.program);
      bindTexture(gl, this.copy.uniforms.uPrev, this.target.texture, 0);
      this.quad.draw();

      card.ctx.drawImage(this.work, 0, 0);
    } catch (err) {
      card.failed = err.message;
      console.error(`[gallery] ${card.manifest.id}`, err);
    }
  }

  // ---------------------------------------------------------------- playback

  async toggle(id) {
    if (this.playing.has(id)) this.stop(id); else await this.start(id);
  }

  async start(id) {
    const card = this.cards.get(id);
    if (!card) return;
    await this.ensureInstance(card);
    if (card.failed) return;

    this.playing.add(id);
    card.el.classList.add('playing');
    card.play.textContent = '❚❚';
    card.play.title = 'Pause';
    this.tick();
  }

  stop(id) {
    const card = this.cards.get(id);
    this.playing.delete(id);
    if (card) {
      card.el.classList.remove('playing');
      card.play.textContent = '▶';
      card.play.title = 'Play this effect';
    }
  }

  stopAll() {
    for (const id of [...this.playing]) this.stop(id);
  }

  /// Play everything currently on screen. Bounded by what you can see rather
  /// than by a number: scrolling brings more in and lets the rest go quiet.
  async playVisible() {
    for (const id of this.visible) await this.start(id);
  }

  tick() {
    if (this.running) return;
    this.running = true;

    const frame = () => {
      if (this.playing.size === 0) { this.running = false; return; }

      const t = this.now();
      for (const id of this.playing) {
        if (!this.visible.has(id)) continue;      // cannot be seen; do not pay for it
        this.drawCard(this.cards.get(id), t);
      }

      this.onStatus(t);
      requestAnimationFrame(frame);
    };

    requestAnimationFrame(frame);
  }

  // ---------------------------------------------------------------- sources

  setPalette(name) {
    this.palette = getPalette(name);
    if (this.playing.size === 0) for (const c of this.cards.values()) if (c.instance) this.drawCard(c, 6.2);
  }

  /// Point the clock at a project: its analysis drives Modulation and its MP3
  /// becomes the transport. Passing null goes back to the synthetic metronome.
  async setProject(name) {
    this.detachAudio();
    this.mod = null;
    this.analysis = null;
    this.useProjectImage(null);
    if (!name) return null;

    this.useProjectImage(name);   // not awaited: the stand-in holds until it lands

    const detail = await (await fetch(`api/projects/${encodeURIComponent(name)}`)).json();
    if (!detail.hasAnalysis) return { name, bpm: null, audio: null };

    this.analysis = await (await fetch(`api/projects/${encodeURIComponent(name)}/analysis`)).json();
    this.mod = new Modulation(this.analysis);

    if (detail.mp3) {
      this.audio = new Audio(`${detail.mediaBase}/source/${encodeURIComponent(detail.mp3)}`);
      this.audio.preload = 'auto';
      this.audio.currentTime = Math.min(this.clockBase, this.duration - 1);
    }
    return { name, bpm: this.analysis.bpm, audio: !!this.audio };
  }

  /// Draw the image effects against this project's first picture, or against the
  /// stand-in when it has none. Failure is not worth reporting - the stand-in is
  /// a perfectly good answer to "what does this effect do".
  async useProjectImage(name) {
    const release = () => {
      if (this.imageTex !== this.stillTex) this.gl.deleteTexture(this.imageTex);
      this.imageTex = this.stillTex;
      this.imageAspect = CELL_W / CELL_H;
    };

    if (!name) { release(); return; }

    try {
      const list = await (await fetch(`api/projects/${encodeURIComponent(name)}/images`)).json();
      if (!Array.isArray(list) || !list.length) { release(); return; }

      const img = new Image();
      img.src = list[0].url;
      await img.decode();

      release();
      this.imageTex = this.uploadCanvas(img);
      this.imageAspect = (img.naturalWidth || 1) / Math.max(1, img.naturalHeight);
    } catch { release(); }
  }

  detachAudio() {
    if (!this.audio) return;
    this.audio.pause();
    this.audio.src = '';
    this.audio = null;
  }

  async toggleAudio() {
    if (!this.audio) return false;
    if (this.audio.paused) {
      // Hand the wall clock's position to the audio so the picture does not jump
      // when the sound starts.
      this.audio.currentTime = Math.min(this.now(), Math.max(0, this.duration - 0.5));
      await this.audio.play();
      this.tick();
      return true;
    }
    this.clockBase = this.audio.currentTime;
    this.wallBase = performance.now() / 1000;
    this.audio.pause();
    return false;
  }

  get audioPlaying() { return !!this.audio && !this.audio.paused; }
}
