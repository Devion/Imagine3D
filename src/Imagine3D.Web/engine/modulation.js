// Turns the analysis into the named values every effect parameter can reference.
//
// This is the layer that makes the demo feel like it matches the music: an effect
// binds "1.0 + 0.4*beatPulse" and gets a punch on every beat without knowing
// anything about tempo, and the same expression works on any song.

const BAND_NAMES = ['sub', 'bass', 'lowMid', 'mid', 'high', 'air'];

/** `bass` -> `bassPeak`. The peak-hold companion of every band. See peakAt(). */
const PEAK_NAMES = BAND_NAMES.map((n) => `${n}Peak`);

/** `bass` -> `bassHit`. Per-band attack. See deriveAttack(). */
const HIT_NAMES = BAND_NAMES.map((n) => `${n}Hit`);

/** `bass` -> `bassRel`. Per-band spectral shape. See deriveShape(). */
const REL_NAMES = BAND_NAMES.map((n) => `${n}Rel`);

/** How long a peak is held before it starts to fall, in seconds. */
const PEAK_HOLD = 0.8;

/** How fast it falls afterwards, in units of the 0..1 range per second. */
const PEAK_FALL = 0.55;

/** What beatPulse is still worth on a beat that landed on nothing. See beatImpact(). */
const PULSE_FLOOR = 0.10;

/** Frames back an attack is measured over. ~50ms at the analysis frame rate. */
const ATTACK_LAG = 2;

/** How fast an attack falls away, in units of the 0..1 range per second. */
const ATTACK_FALL = 6.0;

// ---------------------------------------------------------------- derivation
//
// Band *level* is a poor modulation source on its own, and this is the layer that
// fixes it. Every band rises and falls with the arrangement, so all six move
// together and all six move with the RMS envelope - measured over this repo's own
// songs, the mean |r| between a band and the level is 0.54, and between one band
// and another 0.44. An effect bound to `bass` is therefore bound to a softer copy
// of the beat, which is why a library that reads six bands still looks like it
// only hears one.
//
// Two derivations get out of that, and neither needs anything the analysis does
// not already carry:
//
//   *Rel  - the band against the average across bands at that instant. Answers
//           "which way is the energy leaning", not "how much is there". Drops the
//           correlation with level to 0.15, so a shader driven by it moves when
//           the arrangement changes rather than when the kick lands.
//   *Hit  - the band's own rise. A hi-hat pattern shows up in the top bands and
//           nowhere else, so an effect can respond to the hats while another
//           responds to the kick - which the single onset envelope, being one
//           number for the whole mix, can never express.

/** How many bands the shader-side spectrum carries. Matches BandEnergy.FineCount. */
const FINE_COUNT = 12;

/**
 * Resample a set of band curves onto exactly `n` bands by interpolating across
 * the spectrum, so an analysis carrying a different number of them still
 * presents the fixed-size array the shaders declare. A no-op at the usual count.
 */
function expandTo(bands, n) {
  if (!bands?.length) return [];
  if (bands.length === n) return bands;

  const src = bands.length;
  const frames = bands[0].length;
  return Array.from({ length: n }, (_, i) => {
    // Band centres against band centres, so the ends land on the real end bands
    // rather than half a band outside the spectrum.
    const x = src === 1 ? 0 : (i / (n - 1)) * (src - 1);
    const lo = Math.floor(x), hi = Math.min(src - 1, lo + 1), k = x - lo;
    const out = new Float32Array(frames);
    for (let f = 0; f < frames; f++) out[f] = bands[lo][f] * (1 - k) + bands[hi][f] * k;
    return out;
  });
}

/** Stretch the 2nd-98th percentile of a signal across 0..1. */
function stretch(x, loPct = 0.02, hiPct = 0.98) {
  if (x.length === 0) return x;
  const sorted = Float32Array.from(x).sort();
  const lo = sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * loPct))];
  const hi = sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * hiPct))];
  const span = Math.max(1e-4, hi - lo);
  const out = new Float32Array(x.length);
  for (let i = 0; i < x.length; i++) out[i] = Math.min(1, Math.max(0, (x[i] - lo) / span));
  return out;
}

/**
 * Each band minus the mean across bands at the same instant, stretched to 0..1.
 *
 * Subtracting the instantaneous mean is what removes the loudness: whatever the
 * whole spectrum does together cancels, and what is left is the shape. 0.5 is a
 * band sitting exactly at the average, so an effect that wants "leaning bright"
 * reads `airRel` and gets it whether the passage is loud or quiet.
 */
function deriveShape(bands) {
  const n = bands.length;
  if (n === 0) return [];
  const frames = bands[0].length;
  const raw = Array.from({ length: n }, () => new Float32Array(frames));

  for (let f = 0; f < frames; f++) {
    let mean = 0;
    for (let i = 0; i < n; i++) mean += bands[i][f];
    mean /= n;
    for (let i = 0; i < n; i++) raw[i][f] = bands[i][f] - mean;
  }

  // Stretched per band rather than over all of them together: a band that only
  // ever leans a little still wants its full swing available to an effect.
  return raw.map((r) => stretch(r));
}

/**
 * Each band's own attack: how much it rose over the last ~50ms, normalised
 * against the biggest rises in this song and then allowed to fall away.
 *
 * The rise rather than the level, because a band that is loud and steady is not
 * an event. The fall afterwards is what makes it read as an accent rather than a
 * gate - and it is computed forward over the whole song once, so the value at t
 * stays a pure function of t and a scrubbed preview matches the offline render.
 */
function deriveAttack(bands, frameRate) {
  const decay = Math.exp(-ATTACK_FALL / Math.max(1, frameRate));

  return bands.map((b) => {
    const frames = b.length;
    const raw = new Float32Array(frames);
    for (let f = ATTACK_LAG; f < frames; f++) raw[f] = Math.max(0, b[f] - b[f - ATTACK_LAG]);

    // Against the 97th percentile of this band's own rises, so a band that never
    // gets struck hard still resolves - but floored, or a band with no transients
    // at all would normalise its own noise up to a full-scale hit.
    const sorted = Float32Array.from(raw).sort();
    const ref = Math.max(0.05, sorted[Math.floor(sorted.length * 0.97)] ?? 0);

    const out = new Float32Array(frames);
    let y = 0;
    for (let f = 0; f < frames; f++) {
      y = Math.max(Math.min(1, raw[f] / ref), y * decay);
      out[f] = y;
    }
    return out;
  });
}

/**
 * Spectral centroid over the bands: 0 when all the energy is at the bottom, 1 at
 * the top. One number for "how bright is this passage", which tracks the
 * arrangement — a filter opening, a breakdown dropping to the bass — rather than
 * the beat.
 */
function deriveBrightness(bands) {
  const n = bands.length;
  if (n < 2) return new Float32Array(0);
  const frames = bands[0].length;
  const raw = new Float32Array(frames);

  for (let f = 0; f < frames; f++) {
    let num = 0, den = 0;
    for (let i = 0; i < n; i++) {
      const w = bands[i][f];
      num += w * i;
      den += w;
    }
    raw[f] = den > 1e-6 ? num / den / (n - 1) : 0.5;
  }
  return stretch(raw);
}

export class Modulation {
  constructor(analysis) {
    this.a = analysis;
    this.frameRate = analysis.frameRate || 43;
    this.duration = analysis.duration || 1;
    this.beats = analysis.beats || [];
    this.downbeats = analysis.downbeats || [];
    this.onsets = analysis.onsets || [];
    this.bands = analysis.bands || [];
    this.rmsArr = analysis.rms || [];
    this.sections = analysis.sections || [];

    // The twelve-band spectrum. Absent from an analysis.json written before it
    // existed - the pipeline re-analyses rather than serving one of those, but
    // the gallery can be pointed at any file, so widen the coarse six onto the
    // same twelve slots instead of leaving every fine-band effect reading zero.
    // Always exactly FINE_COUNT afterwards, which is what lets the shader-side
    // array be a fixed size and every effect index it without checking.
    this.fine = expandTo(analysis.fineBands?.length ? analysis.fineBands : this.bands, FINE_COUNT);
    this.fineHz = analysis.fineBandHz || [];
    this.fineCount = this.fine.length;

    this.coarseRel = deriveShape(this.bands);
    this.coarseHit = deriveAttack(this.bands, this.frameRate);
    this.fineRel = deriveShape(this.fine);
    this.fineHit = deriveAttack(this.fine, this.frameRate);
    this.brightnessArr = deriveBrightness(this.fine);

    // Reused every frame so the per-frame path allocates nothing; registry.js
    // uploads them straight to the array uniforms.
    this.bandArr = new Float32Array(this.fineCount);
    this.bandPeakArr = new Float32Array(this.fineCount);
    this.bandRelArr = new Float32Array(this.fineCount);
    this.bandHitArr = new Float32Array(this.fineCount);

    // Fall back to a synthetic grid when beat tracking was not confident enough
    // to trust. Effects still pulse in time; they just follow the nominal tempo
    // instead of a grid that would drift against rubato material.
    this.reliable = analysis.bpmPinned || (analysis.bpmConfidence ?? 0) >= 0.4;
    this.period = 60 / Math.max(1, analysis.bpm || 120);

    this.pace = Modulation.tempoPace(analysis.bpm, this.reliable);

    // What a full-strength beat measures on this song. See beatImpact().
    this.beatRef = this.measureBeatRef();

    this.vars = {
      t: 0, sectionT: 0, sceneT: 0, clipT: 0, imageT: 0,
      // Lyric cue: position through the line, and its timing in beats off the
      // grid. Written by the renderer's text pass (see engine/renderer.js) and
      // read by effects/textcomposite; zero here so a style that steps per beat
      // shows a finished line rather than an empty one when nothing set them.
      cueT: 0, cueBeats: 0, cueSpan: 0, cueIds: 0,
      beat: 0, bar: 0, phrase: 0,
      beatPulse: 0, barPulse: 0, onset: 0, beatStrength: 0,
      rms: 0, energy: 0, index: 0, rmsPeak: 0,
      sub: 0, bass: 0, lowMid: 0, mid: 0, high: 0, air: 0,
      subPeak: 0, bassPeak: 0, lowMidPeak: 0, midPeak: 0, highPeak: 0, airPeak: 0,
      subHit: 0, bassHit: 0, lowMidHit: 0, midHit: 0, highHit: 0, airHit: 0,
      subRel: 0, bassRel: 0, lowMidRel: 0, midRel: 0, highRel: 0, airRel: 0,
      brightness: 0.5,
      bands: {},
      // The fine spectrum for the uniform arrays. Effects reach the same values
      // by name as band0..band11.
      bandArr: this.bandArr,
      bandPeakArr: this.bandPeakArr,
      bandRelArr: this.bandRelArr,
      bandHitArr: this.bandHitArr,
    };
    for (let i = 0; i < this.fineCount; i++) this.vars[`band${i}`] = 0;
  }

  /** Index of the last element of a sorted array that is <= value. */
  static lastBefore(arr, value) {
    let lo = 0, hi = arr.length - 1, best = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (arr[mid] <= value) { best = mid; lo = mid + 1; } else hi = mid - 1;
    }
    return best;
  }

  /**
   * How fast the visuals run against the clock, from the song's tempo.
   *
   * Every free-running animation rate in the library is in wall-clock seconds -
   * `uTime * p_speed` in a shader, `m.t` in a module effect, a `sin(t*0.2)` in a
   * storyboard expression. So a scene runs at exactly the same rate over a 70 BPM
   * ballad as over a 140 BPM dance track, and against slow material it reads as
   * the video being in a hurry the music is not in. The beat-driven sources were
   * never the problem - beatPulse, bar, the band followers all already move with
   * the song. It is the motion underneath them, which nothing was pacing.
   *
   * 120 BPM is the reference because that is roughly what the library was tuned
   * against; the projects in this repo that never drew the complaint sit at 129
   * and 144, and the one that did sits at 70.
   *
   * Asymmetric, deliberately. Below the reference it is proportional: a 70 BPM
   * song has beats that last twice as long, so twice as much of every effect's
   * cycle was landing inside one of them, and nothing short of the full ratio
   * puts that back. Above it the correction is square-rooted and barely moves,
   * because there is no evidence the library is too *slow* on fast material -
   * speeding those songs up would be a change nobody asked for, made on the
   * strength of a complaint about the opposite case.
   *
   * Clamped at both ends. Tempo is a real signal about how fast a song moves but
   * it is not the only one - a slow track can be dense, a fast one sparse - and
   * past about 66 BPM the ratio stops describing anything anyone wants to watch.
   *
   * Only applied where the tempo is worth believing. An unreliable estimate is
   * as likely to be the half or the double of the real one, and pacing a whole
   * video to a wrong number is worse than not pacing it at all.
   */
  static tempoPace(bpm, reliable) {
    if (!reliable || !(bpm > 1)) return 1;
    const ratio = bpm / 120;
    return ratio < 1 ? Math.max(0.55, ratio) : Math.min(1.15, Math.sqrt(ratio));
  }

  /**
   * Fractional position in the beat grid at time t - beat 3 halfway to beat 4
   * is 3.5. Before the first tracked beat it extrapolates backwards at the
   * nominal period, so a line that starts in the pickup still gets a sane
   * count instead of clamping to zero and stalling everything reading it.
   */
  beatPos(t) {
    const i = Modulation.lastBefore(this.beats, t);
    if (i < 0) return (t - (this.beats[0] ?? 0)) / this.period;
    const cur = this.beats[i];
    const next = this.beats[i + 1] ?? cur + this.period;
    return i + (t - cur) / Math.max(1e-6, next - cur);
  }

  /**
   * How many beats separate two times, fractionally.
   *
   * Counted off the grid rather than divided by the nominal period, which is
   * what keeps a word-per-beat lyric style on the beat through a tempo that
   * drifts: the grid is where the beats actually are, the period is only where
   * they would be if nothing ever moved. Where the grid was not trusted enough
   * to use (see `reliable`) the period is all there is, and the words step at
   * the nominal tempo - the same fallback every other beat-driven source takes.
   */
  beatsBetween(a, b) {
    if (!(b > a)) return 0;
    if (!this.reliable || this.beats.length < 2) return (b - a) / this.period;
    return this.beatPos(b) - this.beatPos(a);
  }

  sampleFrame(arr, t) {
    if (!arr || arr.length === 0) return 0;
    const i = Math.min(arr.length - 1, Math.max(0, Math.round(t * this.frameRate)));
    return arr[i] ?? 0;
  }

  /** Largest value of `arr` within ±w seconds of t. */
  peakNear(arr, t, w) {
    if (!arr || arr.length === 0) return 0;
    const step = 1 / this.frameRate;
    let best = 0;
    for (let d = -w; d <= w; d += step) best = Math.max(best, this.sampleFrame(arr, t + d));
    return best;
  }

  /**
   * How hard the beat at `beatTime` actually landed, 0..1.
   *
   * The beat grid is a metronome. It ticks through a breakdown at exactly the
   * rate it ticks through a chorus, so every effect bound to beatPulse bumps
   * whether or not anything hit — the visuals dancing while the music is not.
   * That cannot be fixed in the effects, because it is not their mistake: they
   * were told a beat happened and it did. What they were never told is whether
   * it was worth anything.
   *
   * Two signals, because neither is enough alone. The onset envelope says
   * something *started*, but OnsetEnvelope.SubtractLocalMean deliberately takes
   * the slow loudness trend out of it so the beat tracker can work through a
   * quiet intro — which leaves it unable to tell loud from soft. The RMS
   * follower knows loud from soft but not struck from sustained. Measured over
   * this repo's own songs there are sections sitting at RMS 0.48 with an onset
   * score of 0.01: full level, nothing hitting, and exactly the passages that
   * should not be pulsing. The product says "something started, and it was
   * loud", which is what a beat is.
   *
   * A half-time section falls out of the same rule rather than needing its own:
   * the off-beats carry no transient, so they score near zero and the visuals
   * pulse at the rate the music does, not the rate the grid does.
   */
  beatImpact(beatTime) {
    const raw = this.peakNear(this.a?.onset, beatTime, 0.06) * this.sampleFrame(this.rmsArr, beatTime);
    return Math.min(1, raw / this.beatRef);
  }

  /**
   * What counts as a full-strength beat on this song, from the 90th percentile of
   * every beat's impact — so the loudest tenth saturate and the rest are read
   * against them.
   *
   * Floored, because the reference is a percentile of this song and a song with
   * no percussion at all would otherwise normalise its own near-silence up to
   * full strength and pulse exactly as hard as a drum track.
   */
  measureBeatRef() {
    const grid = this.beats.length > 1
      ? this.beats
      : Array.from({ length: Math.floor(this.duration / this.period) }, (_, i) => i * this.period);
    if (grid.length === 0) return 1;

    const impacts = grid
      .map((b) => this.peakNear(this.a?.onset, b, 0.06) * this.sampleFrame(this.rmsArr, b))
      .sort((a, b) => a - b);
    return Math.max(0.08, impacts[Math.floor(impacts.length * 0.90)] ?? 0);
  }

  /**
   * The falling peak indicator every meter has: hold the loudest recent value for
   * a moment, then let it slide down at a fixed rate.
   *
   * Computed by looking *back* over the analysis rather than by carrying a running
   * maximum, because a running maximum would make the value at time t depend on
   * which frames happened to be rendered before it - so scrubbing the preview and
   * rendering offline would disagree, and the offline render is the one that has
   * to be reproducible. Reading the window makes peak(t) a pure function of t: a
   * peak set `age` seconds ago is currently worth `value - (age - hold) * fall`,
   * and the indicator sits at the largest of those.
   */
  peakAt(arr, t) {
    if (!arr || arr.length === 0) return 0;
    const now = Math.min(arr.length - 1, Math.max(0, Math.round(t * this.frameRate)));

    let best = 0;
    for (let i = now; i >= 0; i--) {
      const drop = Math.max(0, (now - i) / this.frameRate - PEAK_HOLD) * PEAK_FALL;
      // The bands are normalised to 0..1, so once even a full-scale hit this far
      // back would land below what we already have, nothing older can beat it.
      if (1 - drop <= best) break;
      const v = (arr[i] ?? 0) - drop;
      if (v > best) best = v;
    }
    return best;
  }

  /**
   * Compute every modulation value at time t.
   * `scene` supplies sceneT; `extra` merges in anything scene-specific.
   *
   * `t` as the effects see it is measured from the top of the scene and paced to
   * the song's tempo. Everything else here still reads the real time: the beat
   * grid, the band followers, and every position through a scene, section or cue
   * are where they are in the song. Only free-running motion is touched.
   *
   * Scene-relative because of what the library does with it. Almost every effect
   * animates as `uTime * p_speed`, and almost every manifest modulates that speed
   * with the music - `0.28 + 0.16*rms + 0.15*midRel`. The music moving the speed
   * a little every frame is the whole point, but the multiply turns that wobble
   * into a phase jump the size of *t*: seven minutes into a song, a one percent
   * flicker in rms is several seconds of animation inside one frame. The effect
   * stops being fast and starts being random, and it gets worse the longer the
   * song runs - which is why it showed up first on a seven-minute one.
   *
   * Integrating the rate instead of multiplying by it is the textbook answer, but
   * renderAt(t) has to stand alone - the preview scrubs and the offline encoder
   * asks for arbitrary frames - so there is no running phase to accumulate into.
   * Restarting the clock each scene is what is left, and it costs nothing: the
   * boundary it jumps at is a cut or a transition, where the picture is being
   * replaced anyway. Measured over this repo's own plans it takes mean
   * frame-to-frame correlation from 0.69 to 0.84, and the number of scenes with
   * no frame-to-frame continuity at all from seven to one.
   *
   * A pass that has to stay continuous across a cut - the lyric layer, which is
   * on screen while the scene under it changes - overrides `t` through `extra`.
   */
  at(t, scene = null, extra = null) {
    const v = this.vars;
    v.t = (scene ? t - scene.start : t) * this.pace;

    // --- beat / bar / phrase -------------------------------------------------
    let sinceBeat, beatFrac, beatIndex, beatTime;
    if (this.reliable && this.beats.length > 1) {
      beatIndex = Modulation.lastBefore(this.beats, t);
      if (beatIndex < 0) { sinceBeat = 0; beatFrac = 0; beatIndex = 0; beatTime = this.beats[0] ?? 0; }
      else {
        const cur = this.beats[beatIndex];
        const next = this.beats[beatIndex + 1] ?? cur + this.period;
        sinceBeat = t - cur;
        beatFrac = Math.min(1, sinceBeat / Math.max(1e-6, next - cur));
        beatTime = cur;
      }
    } else {
      const phase = t / this.period;
      beatIndex = Math.floor(phase);
      beatFrac = phase - beatIndex;
      sinceBeat = beatFrac * this.period;
      beatTime = beatIndex * this.period;
    }

    v.beat = beatFrac;
    v.index = beatIndex;
    v.beatStrength = this.beatImpact(beatTime);

    // Exponential decay from each beat - the workhorse for "punch on the hit" -
    // scaled by whether the hit was worth anything. The floor is there so a
    // passage with no transients goes quiet rather than going dead; everything
    // in the library reads beatPulse, and dropping it to a hard zero stops the
    // frame moving at all rather than stopping it bumping.
    v.beatPulse = (PULSE_FLOOR + (1 - PULSE_FLOOR) * v.beatStrength) * Math.exp(-sinceBeat * 7);

    const barLen = this.period * 4;
    let sinceBar, barTime;
    if (this.reliable && this.downbeats.length > 0) {
      const di = Modulation.lastBefore(this.downbeats, t);
      sinceBar = di < 0 ? t : t - this.downbeats[di];
      const next = this.downbeats[di + 1] ?? this.downbeats[di] + barLen;
      const cur = this.downbeats[di] ?? 0;
      v.bar = Math.min(1, sinceBar / Math.max(1e-6, next - cur));
      barTime = cur;
    } else {
      const p = t / barLen;
      v.bar = p - Math.floor(p);
      sinceBar = v.bar * barLen;
      barTime = t - sinceBar;
    }
    // Gated on the downbeat's own impact, not the last beat's: a bar that opens
    // on nothing should not swell just because beat three had a hi-hat.
    const barStrength = this.beatImpact(barTime);
    v.barPulse = (PULSE_FLOOR + (1 - PULSE_FLOOR) * barStrength) * Math.exp(-sinceBar * 2.5);

    const phraseLen = barLen * 4;
    v.phrase = (t % phraseLen) / phraseLen;

    // --- level and spectrum --------------------------------------------------
    v.rms = this.sampleFrame(this.rmsArr, t);
    v.rmsPeak = this.peakAt(this.rmsArr, t);
    for (let i = 0; i < BAND_NAMES.length; i++) {
      const value = this.sampleFrame(this.bands[i], t);
      v[BAND_NAMES[i]] = value;
      v.bands[BAND_NAMES[i]] = value;
      v[PEAK_NAMES[i]] = this.peakAt(this.bands[i], t);
      v[HIT_NAMES[i]] = this.sampleFrame(this.coarseHit[i], t);
      v[REL_NAMES[i]] = this.sampleFrame(this.coarseRel[i], t);
    }

    for (let i = 0; i < this.fineCount; i++) {
      const value = this.sampleFrame(this.fine[i], t);
      v[`band${i}`] = value;
      this.bandArr[i] = value;
      this.bandPeakArr[i] = this.peakAt(this.fine[i], t);
      this.bandRelArr[i] = this.sampleFrame(this.fineRel[i], t);
      this.bandHitArr[i] = this.sampleFrame(this.fineHit[i], t);
    }

    v.brightness = this.sampleFrame(this.brightnessArr, t);

    // Onset strength decays quickly so it reads as an accent, not a level.
    v.onset = this.sampleFrame(this.a.onset, t);

    // --- section / scene -----------------------------------------------------
    const sec = this.sectionAt(t);
    if (sec) {
      v.sectionT = (t - sec.start) / Math.max(1e-6, sec.end - sec.start);
      v.energy = sec.energy;
    } else {
      v.sectionT = t / this.duration;
      v.energy = v.rms;
    }

    v.sceneT = scene
      ? Math.min(1, Math.max(0, (t - scene.start) / Math.max(1e-6, scene.end - scene.start)))
      : v.sectionT;

    if (extra) Object.assign(v, extra);
    return v;
  }

  sectionAt(t) {
    const s = this.sections;
    if (!s.length) return null;
    let lo = 0, hi = s.length - 1, best = 0;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (s[mid].start <= t) { best = mid; lo = mid + 1; } else hi = mid - 1;
    }
    return s[best];
  }
}

export { BAND_NAMES, PEAK_NAMES, HIT_NAMES, REL_NAMES, FINE_COUNT };
