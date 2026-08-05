// Turns the analysis into the named values every effect parameter can reference.
//
// This is the layer that makes the demo feel like it matches the music: an effect
// binds "1.0 + 0.4*beatPulse" and gets a punch on every beat without knowing
// anything about tempo, and the same expression works on any song.

const BAND_NAMES = ['sub', 'bass', 'lowMid', 'mid', 'high', 'air'];

/** `bass` -> `bassPeak`. The peak-hold companion of every band. See peakAt(). */
const PEAK_NAMES = BAND_NAMES.map((n) => `${n}Peak`);

/** How long a peak is held before it starts to fall, in seconds. */
const PEAK_HOLD = 0.8;

/** How fast it falls afterwards, in units of the 0..1 range per second. */
const PEAK_FALL = 0.55;

/** What beatPulse is still worth on a beat that landed on nothing. See beatImpact(). */
const PULSE_FLOOR = 0.10;

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

    // Fall back to a synthetic grid when beat tracking was not confident enough
    // to trust. Effects still pulse in time; they just follow the nominal tempo
    // instead of a grid that would drift against rubato material.
    this.reliable = analysis.bpmPinned || (analysis.bpmConfidence ?? 0) >= 0.4;
    this.period = 60 / Math.max(1, analysis.bpm || 120);

    // What a full-strength beat measures on this song. See beatImpact().
    this.beatRef = this.measureBeatRef();

    this.vars = {
      t: 0, sectionT: 0, sceneT: 0, clipT: 0,
      beat: 0, bar: 0, phrase: 0,
      beatPulse: 0, barPulse: 0, onset: 0, beatStrength: 0,
      rms: 0, energy: 0, index: 0, rmsPeak: 0,
      sub: 0, bass: 0, lowMid: 0, mid: 0, high: 0, air: 0,
      subPeak: 0, bassPeak: 0, lowMidPeak: 0, midPeak: 0, highPeak: 0, airPeak: 0,
      bands: {},
    };
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
   */
  at(t, scene = null, extra = null) {
    const v = this.vars;
    v.t = t;

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
    }

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

export { BAND_NAMES, PEAK_NAMES };
