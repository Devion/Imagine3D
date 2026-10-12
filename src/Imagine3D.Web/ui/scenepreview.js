import { effectiveScenes } from '../engine/timing.js';
// Play one scene of the storyboard, in place, in the list.
//
// This is the question the scene list actually asks - "is this the right effect
// for this bit of the song" - and it cannot be answered by a name and an energy
// number. It needs the effect running, with this scene's parameters, over this
// part of the music.
//
// So it uses the real compositor rather than drawing the effect on its own.
// Renderer.renderAt() is the same call the offline render makes: the scene, then
// its own post stack, then the transition it comes in through, then the lyric
// layer. Previewing the bare shader would answer a different question and would
// quietly mislead - half the scenes in a plan carry two or three post passes, and
// pixelate over kaliset is not kaliset.
//
// One canvas and one GL context for the whole list, moved into whichever row is
// playing. A context per row would be a context per scene, which no browser will
// give you, and the compositor is not cheap to stand up twice.

import { Renderer } from '../engine/renderer.js';

const W = 448, H = 252;

export class ScenePreview {
  constructor({ onError = () => {} } = {}) {
    this.onError = onError;

    this.canvas = document.createElement('canvas');
    this.canvas.className = 'scene-canvas';
    this.canvas.width = W;
    this.canvas.height = H;

    this.renderer = null;
    this.loadedFor = null;      // storyboard identity the renderer was built for
    this.index = null;          // scene currently playing
    this.raf = 0;
    this.audio = null;
    this.withAudio = true;
  }

  get playing() { return this.index !== null; }

  /// Throw the built renderer away. Called whenever the plan changes: swapping a
  /// scene's effect means a shader that was never compiled and parameters that
  /// were never bound, and reusing the old renderer would keep showing the old
  /// effect - which is exactly the moment a preview must not lie.
  invalidate() {
    this.stop();
    this.renderer?.dispose();
    this.renderer = null;
    this.loadedFor = null;
  }

  async ensure({ analysis, storyboard, mediaBase }) {
    const key = `${storyboard.seed}:${storyboard.scenes.map((s) => s.effectId).join(',')}`;
    if (this.renderer && this.loadedFor === key) return this.renderer;

    this.renderer?.dispose();
    this.renderer = new Renderer(this.canvas, W, H);

    // No LTX. The clips are seconds of video per insert and the compositor waits
    // on each seek; a preview that has to buffer is not a preview. What the
    // scene's own effects do is the question here.
    const warnings = await this.renderer.load(analysis, { ...storyboard, ltx: [] }, mediaBase);
    if (warnings.length) this.onError(warnings);

    this.loadedFor = key;
    return this.renderer;
  }

  async toggle(index, ctx) {
    if (this.index === index) { this.stop(); return; }
    await this.play(index, ctx);
  }

  async play(index, ctx) {
    this.stop();

    const scene = effectiveScenes(ctx.storyboard)[index];
    if (!scene) return;

    const slot = document.querySelector(`.scene-shot[data-index="${index}"]`);
    if (!slot) return;

    slot.append(this.canvas);
    slot.classList.add('open');
    this.index = index;

    let renderer;
    try {
      renderer = await this.ensure(ctx);
    } catch (e) {
      this.onError([`Preview failed: ${e.message}`]);
      this.stop();
      return;
    }

    // Start a moment before the scene so the transition into it is part of what
    // you see. That is half of what a boundary looks like, and it is the half
    // the scene list otherwise only tells you the name of.
    const lead = Math.min(scene.transitionDuration || 0, 1.2);
    const from = Math.max(0, scene.start - lead);
    const to = Math.max(from + 0.5, scene.end);

    if (this.withAudio && ctx.audioSrc) {
      this.audio = new Audio(ctx.audioSrc);
      this.audio.currentTime = from;
      this.audio.play().catch(() => { /* autoplay refused; the picture still runs */ });
    }

    const wall0 = performance.now() / 1000;

    const frame = () => {
      if (this.index !== index) return;

      // Follow the audio when there is any, so picture and sound cannot drift;
      // otherwise a wall clock. Either way, loop the scene's own window.
      let t = this.audio && !this.audio.paused
        ? this.audio.currentTime
        : from + ((performance.now() / 1000) - wall0) % (to - from);

      if (t >= to || t < from) {
        t = from;
        if (this.audio) this.audio.currentTime = from;
      }

      try {
        renderer.renderAt(t);
        renderer.present();
      } catch (e) {
        this.onError([`Preview failed at ${t.toFixed(1)}s: ${e.message}`]);
        this.stop();
        return;
      }

      this.raf = requestAnimationFrame(frame);
    };

    this.raf = requestAnimationFrame(frame);
  }

  stop() {
    if (this.raf) cancelAnimationFrame(this.raf);
    this.raf = 0;

    if (this.audio) { this.audio.pause(); this.audio.src = ''; this.audio = null; }

    if (this.index !== null) {
      const slot = document.querySelector(`.scene-shot[data-index="${this.index}"]`);
      slot?.classList.remove('open');
      this.canvas.remove();
    }
    this.index = null;
  }
}
