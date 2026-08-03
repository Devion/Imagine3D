// Turns the analysis into the named values every effect parameter can reference.
//
// This is the layer that makes the demo feel like it matches the music: an effect
// binds "1.0 + 0.4*beatPulse" and gets a punch on every beat without knowing
// anything about tempo, and the same expression works on any song.

const BAND_NAMES = ['sub', 'bass', 'lowMid', 'mid', 'high', 'air'];

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

    this.vars = {
      t: 0, sectionT: 0, sceneT: 0, clipT: 0,
      beat: 0, bar: 0, phrase: 0,
      beatPulse: 0, barPulse: 0, onset: 0,
      rms: 0, energy: 0, index: 0,
      sub: 0, bass: 0, lowMid: 0, mid: 0, high: 0, air: 0,
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

  /**
   * Compute every modulation value at time t.
   * `scene` supplies sceneT; `extra` merges in anything scene-specific.
   */
  at(t, scene = null, extra = null) {
    const v = this.vars;
    v.t = t;

    // --- beat / bar / phrase -------------------------------------------------
    let sinceBeat, beatFrac, beatIndex;
    if (this.reliable && this.beats.length > 1) {
      beatIndex = Modulation.lastBefore(this.beats, t);
      if (beatIndex < 0) { sinceBeat = 0; beatFrac = 0; beatIndex = 0; }
      else {
        const cur = this.beats[beatIndex];
        const next = this.beats[beatIndex + 1] ?? cur + this.period;
        sinceBeat = t - cur;
        beatFrac = Math.min(1, sinceBeat / Math.max(1e-6, next - cur));
      }
    } else {
      const phase = t / this.period;
      beatIndex = Math.floor(phase);
      beatFrac = phase - beatIndex;
      sinceBeat = beatFrac * this.period;
    }

    v.beat = beatFrac;
    v.index = beatIndex;

    // Exponential decay from each beat - the workhorse for "punch on the hit".
    v.beatPulse = Math.exp(-sinceBeat * 7);

    const barLen = this.period * 4;
    let sinceBar;
    if (this.reliable && this.downbeats.length > 0) {
      const di = Modulation.lastBefore(this.downbeats, t);
      sinceBar = di < 0 ? t : t - this.downbeats[di];
      const next = this.downbeats[di + 1] ?? this.downbeats[di] + barLen;
      const cur = this.downbeats[di] ?? 0;
      v.bar = Math.min(1, sinceBar / Math.max(1e-6, next - cur));
    } else {
      const p = t / barLen;
      v.bar = p - Math.floor(p);
      sinceBar = v.bar * barLen;
    }
    v.barPulse = Math.exp(-sinceBar * 2.5);

    const phraseLen = barLen * 4;
    v.phrase = (t % phraseLen) / phraseLen;

    // --- level and spectrum --------------------------------------------------
    v.rms = this.sampleFrame(this.rmsArr, t);
    for (let i = 0; i < BAND_NAMES.length; i++) {
      const value = this.sampleFrame(this.bands[i], t);
      v[BAND_NAMES[i]] = value;
      v.bands[BAND_NAMES[i]] = value;
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

export { BAND_NAMES };
