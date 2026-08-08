#include "common.glsl"
#include "palette.glsl"

// The text raster arrives from engine/textlayer.js: the glyph mask in alpha and,
// per word, its place in the line's reading order, a random of its own and which
// wrapped row it sits on in the colour channels. All the character comes from
// what happens here.
//
// uAmount carries the style index and p_cue is 0..1 through the line's own
// lifetime. Two rules bind every style in this file.
//
// It has to stay READABLE. Motion returns to rest, the letterforms are never
// permanently warped, and no word is held dark long enough to be missed. A style
// that cannot be read is not a lyric treatment, it is a texture.
//
// It has to be ON something the music is doing - a beat off the tracked grid, a
// band, or the singer's own position in the line - never a free-running timer.
// That is the difference between text that is part of the record and text that
// merely happens to be moving while the record plays.
//
// The frame is built in three steps, and the per-word styles need all three.
// Displacement first, as a *lookup* offset: the pixel reads the mask from where
// the letter used to be. Then one gather at that position, which is where the
// pixel finds out which word it is actually showing. Only then the per-word
// lighting. Splitting it that way is not tidiness - see gather() for what
// happens to a style that hides words when it is done in one pass.
//
// This shader sits close to what ANGLE's HLSL backend will accept: ten styles,
// and up to fifteen taps of the text raster on the heaviest of them. It links in
// about 0.7s and a link that fails comes back with an empty log, so if you add
// to it, add cheaply. Two things cost far more than they look. A `return` inside
// one of the tap loops is a branch per unrolled iteration - use a predicate. And
// every indexed read of a uniform array (uBands[i] and everything in panel.glsl
// built on it) expands to a twelve-way branch, which is why the spectrum style
// below reads the six named band uniforms instead.

struct Word { float order; float rnd; float row; float mask; };

/// Coverage below which a texel is treated as carrying no word. Shared by the id
/// read and the early-out, so a pixel can never be lit by a word the id read has
/// already refused to trust.
const float COVERED = 0.02;

/// The word ids under `uv`.
///
/// Dividing the colour by the alpha undoes the coverage the filter mixed in, so
/// a half-covered rim texel reports the same word as the solid middle of the
/// glyph rather than one pulled toward zero.
///
/// The threshold is not defensive tidiness. A texel the glyphs never touched
/// still comes back with colour in it - transparent black is not what survives
/// the canvas upload - and dividing that by an alpha of zero saturates to id
/// 1.0: a phantom word ordered after every real one and covering the whole
/// frame. A style that steps word by word then waits on a word that does not
/// exist, and the line is drawn a second time, displaced, until the phantom's
/// turn finally comes.
///
/// Under it - and for a raster carrying no ids at all, which is what the effect
/// gallery's plain sample line is - a pixel reads as the first word, already
/// sung and already landed. That is the fallback that leaves text legible.
Word wordAt(vec2 uv) {
  // textureLod, not texture: the raster has no mipmaps, so level 0 is the only
  // thing there is to read, and asking for it explicitly keeps the taps out of
  // the implicit-derivative path they sit in inside the loops below.
  vec4 t = textureLod(uText, uv, 0.0);
  float trust = step(COVERED, t.a) * step(0.5, p_ids);
  vec3 id = sat(t.rgb / max(t.a, COVERED));
  return Word(id.r * trust, mix(0.5, id.g, trust), mix(0.5, id.b, trust), t.a);
}

/// The word a pixel is showing, for the styles that move a word off its rest
/// position: where a word has moved *to* carries no ids of its own, so it has to
/// be found by searching back along the axis it travelled. One-sided on purpose
/// - searching both ways lets a pixel adopt a word that moved *away* from it and
/// draw a second copy of it. A miss leaves mask at 0, which every caller reads
/// as "nothing of this line is here" and leaves undisplaced.
Word wordFrom(vec2 uv, vec2 back, float reach) {
  Word best = wordAt(uv);
  for (int i = 1; i <= 5; i++) {
    Word s = wordAt(uv + back * (float(i) / 5.0 * reach));
    // Nearest hit wins: once something covered has been found a further tap must
    // not replace it. A predicate rather than an early return - see the header.
    float take = step(best.mask, COVERED) * step(COVERED, s.mask);
    best.order = mix(best.order, s.order, take);
    best.rnd = mix(best.rnd, s.rnd, take);
    best.row = mix(best.row, s.row, take);
    best.mask = mix(best.mask, s.mask, take);
  }
  return best;
}

struct Found { float mask; float halo; Word word; };

/// One gather at the sampled position: glyph coverage, that coverage dilated by
/// a couple of texels for the outline, and whose word the pixel belongs to - the
/// nearest covered texel's, which for an outline pixel is the letter it is the
/// outline of.
///
/// All three have to come out of the same taps. Attributing the outline to a
/// word is not decoration: a style that holds a word back until its beat has to
/// hold that word's outline back with it. Ask the mask alone and every pixel
/// beside a letter belongs to no word, falls back to the first one - which has
/// always already arrived - and every word still waiting on its beat is drawn as
/// a dark scribble of its own outline over the scene.
Found gather(vec2 uv) {
  vec2 px = 2.2 / uResolution;
  vec2 dg = px * 0.72;
  vec2 taps[8] = vec2[8](
    vec2(px.x, 0.0), vec2(-px.x, 0.0), vec2(0.0, px.y), vec2(0.0, -px.y),
    vec2(dg.x, dg.y), vec2(-dg.x, dg.y), vec2(dg.x, -dg.y), vec2(-dg.x, -dg.y));

  Found f;
  f.word = wordAt(uv);
  f.mask = f.word.mask;
  f.halo = f.mask;
  for (int i = 0; i < 8; i++) {
    Word s = wordAt(uv + taps[i]);
    f.halo = max(f.halo, s.mask);
    float take = step(f.word.mask, s.mask);
    f.word.order = mix(f.word.order, s.order, take);
    f.word.rnd = mix(f.word.rnd, s.rnd, take);
    f.word.row = mix(f.word.row, s.row, take);
    f.word.mask = mix(f.word.mask, s.mask, take);
  }
  return f;
}

/// Six band followers read as one continuous curve over 0..1.
///
/// The same job as spectrumNow() in panel.glsl, off the named uniforms instead
/// of the twelve-band array - see the header for why this shader cannot afford
/// the indexed version.
float bandAt(float t, float b0, float b1, float b2, float b3, float b4, float b5) {
  float x = clamp(t, 0.0, 1.0) * 5.0;
  return b0 * max(0.0, 1.0 - abs(x))
       + b1 * max(0.0, 1.0 - abs(x - 1.0))
       + b2 * max(0.0, 1.0 - abs(x - 2.0))
       + b3 * max(0.0, 1.0 - abs(x - 3.0))
       + b4 * max(0.0, 1.0 - abs(x - 4.0))
       + b5 * max(0.0, 1.0 - abs(x - 5.0));
}

/// Beats since word `w` was due to land, for the cascade.
///
/// The steps are packed into the first three quarters of the line for the same
/// reason the karaoke wipe finishes early: measured on this repo's own cues, a
/// last word due at its own share of the line lands about where the line starts
/// fading out, so the word you most need to read gets a fifth of a second.
/// Landing a little ahead of the vocal is what a lyric video wants anyway - you
/// read the word as it is sung, not after it.
float cascadeSince(Word w) {
  float span = max(1.0, p_span * 0.75);
  // With no cue timing supplied (the gallery, the contact sheet) the line shows
  // landed rather than not showing at all.
  return (p_span > 0.5 ? p_beats : 99.0) - floor(w.order * span);
}

/// Where the line sits in the frame - engine/textlayer.js centres it on 0.78 of
/// the canvas, which is 0.22 up the flipped texture.
const vec2 LINE_CENTRE = vec2(0.5, 0.22);

void main() {
  int style = int(uAmount + 0.5);
  float k = clamp(p_cue, 0.0, 1.0);

  vec2 uv = vUv;
  float alpha = 1.0;   // the line as a whole
  float lit = 1.0;     // this word's share of the ink
  float glow = 0.0;    // additive accent, on the glyph and just outside it

  // ---------------------------------------------------------- displacement

  if (style == 0) {
    // Per-column sine offset - the classic wavy scroller. Amplitude rides the
    // bass so the text breathes with the track.
    float amp = 0.012 + 0.02 * uBass;
    uv.y += sin(uv.x * 9.0 + uTime * 2.4) * amp;
    uv.x += sin(uv.y * 5.0 - uTime * 1.1) * amp * 0.4;
    alpha = smoothstep(0.0, 0.12, k) * smoothstep(0.0, 0.18, 1.0 - k);
  } else if (style == 1) {
    // Slam: punches in oversized on the beat and settles.
    float scale = 1.0 + 0.35 * exp(-k * 14.0) + 0.06 * uBeatPulse;
    uv = (uv - 0.5) / scale + 0.5;
    alpha = smoothstep(0.0, 0.05, k) * smoothstep(0.0, 0.25, 1.0 - k);
  } else if (style == 2) {
    alpha = smoothstep(0.0, 0.3, k) * smoothstep(0.0, 0.35, 1.0 - k) * 0.85;
  } else if (style == 3) {
    // Scroll right-to-left across the frame.
    uv.x += k * 1.6 - 0.8;
    uv.y += sin(uv.x * 7.0 + uTime * 2.0) * 0.01;
    alpha = 1.0;
  } else if (style == 4) {
    // Karaoke wipe: nothing moves at all, which makes this the one to reach for
    // when the line has to be read. The lighting is done below.
    alpha = smoothstep(0.0, 0.08, k) * smoothstep(0.0, 0.14, 1.0 - k);
  } else if (style == 5) {
    // A word per beat, dropped in and then left alone. p_beats counts off the
    // tracked grid rather than off the nominal tempo, so the words keep landing
    // on the beat through a tempo that moves.
    float since = cascadeSince(wordFrom(uv, vec2(0.0, -1.0), 0.06));
    float drop = 1.0 - smoothstep(0.0, 0.5, since);
    // The bounce is sized by how hard the beat under it actually hit, so a word
    // set down in a breakdown lands softly instead of slapping.
    float bounce = exp(-max(0.0, since) * 5.0) * sin(since * 16.0) * 0.007 * uBeatStrength;
    uv.y -= drop * drop * 0.05 + bounce;
    alpha = smoothstep(0.0, 0.16, 1.0 - k);
  } else if (style == 6) {
    // The line rides the spectrum: each column of letters lifts with the band
    // living at that part of the frame and lights with how hard that band was
    // just struck. The band axis is mapped across the text rather than across
    // the frame, so a centred line spans the spectrum instead of sitting on two
    // bands out of six.
    //
    // Deliberately small. A letter that moves further than its own stroke width
    // stops being a letter, and this is the arrangement showing through the
    // text, not the text dancing to it.
    float band = sat((uv.x - 0.15) / 0.7);
    float now = bandAt(band, uSub, uBass, uLowMid, uMid, uHigh, uAir);
    float hit = bandAt(band, uSubHit, uBassHit, uLowMidHit, uMidHit, uHighHit, uAirHit);
    float rel = bandAt(band, uSubRel, uBassRel, uLowMidRel, uMidRel, uHighRel, uAirRel);
    uv.y -= (now - 0.5) * 0.02 + hit * 0.01;
    lit = mix(0.75, 1.0, sat(rel * 1.4));
    glow = hit * 0.55;
    alpha = smoothstep(0.0, 0.12, k) * smoothstep(0.0, 0.16, 1.0 - k);
  } else if (style == 7) {
    // A ring leaves the middle of the line on every beat and passes out through
    // the letters. uBeat is the sawtooth across the tracked beat, so the front
    // starts exactly on the hit; between rings the text is perfectly still,
    // which is what keeps a distorting style readable.
    vec2 d = (uv - LINE_CENTRE) * vec2(uAspect, 1.0);
    float r = length(d);
    float front = uBeat * 0.85;
    // A narrow Gaussian: only the sliver of text the wave is passing through
    // bends, and everything behind and ahead of it is already back at rest.
    float ring = exp(-pow((r - front) * 8.0, 2.0));
    float amp = 0.022 * uBeatStrength * (0.35 + 0.9 * uBass);
    uv += normalize(d + 1e-4) * ring * amp * sin((r - front) * 26.0);
    glow = ring * uBeatStrength * 0.5;
    alpha = smoothstep(0.0, 0.1, k) * smoothstep(0.0, 0.16, 1.0 - k);
  } else if (style == 8) {
    // Drift: every word bobbing on a slow phase of its own, taken from its own
    // random. Nothing here is on the grid - the swell is uRms, so the line
    // breathes with the take rather than pulsing at it, which is what a quiet
    // passage wants and what the plain fade has never had.
    //
    // Vertical, and only ever upward from rest. A word that drifted sideways
    // would have to be found by searching sideways, and the gap between two
    // words is narrower than the gap between two rows - the search would start
    // picking up its neighbour. Keeping the bob one-signed means one search
    // instead of two.
    Word w = wordFrom(uv, vec2(0.0, -1.0), 0.02);
    float ph = w.rnd * TAU;
    uv.y -= (0.5 + 0.5 * sin(uTime * 0.8 + ph)) * (0.005 + 0.009 * uRms);
    glow = uRms * 0.22;
    alpha = smoothstep(0.0, 0.32, k) * smoothstep(0.0, 0.38, 1.0 - k) * 0.95;
  } else {
    // Shatter: horizontal slices jump sideways when something actually hits and
    // are back within a fraction of a beat.
    //
    // The jolt is the size of the transient, not of a timer, so a line held over
    // a pad does not move at all and one over a snare tears. Only about a third
    // of the slices move on any given hit - shoving all of them is a whole-line
    // translation, which reads as the video slipping rather than as the text
    // being hit.
    float hit = sat(max(uOnset, uHighHit) * (0.4 + 0.8 * uBeatStrength));
    float slice = floor(uv.y * 64.0);
    float era = floor(uTime * 14.0);
    float pick = step(0.62, hash11(slice * 1.7 + era));
    uv.x -= (hash11(slice + era) - 0.5) * hit * 0.06 * pick;
    glow = hit * 0.35;
    alpha = smoothstep(0.0, 0.06, k) * smoothstep(0.0, 0.16, 1.0 - k);
  }

  // ------------------------------------------------------ what was found

  vec3 base = texture(uPrev, vUv).rgb;
  float a = sat(alpha);
  if (a < 0.004 || uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0) {
    fragColor = vec4(base, 1.0);
    return;
  }

  Found f = gather(uv);
  if (f.halo < COVERED) { fragColor = vec4(base, 1.0); return; }

  // ------------------------------------------------- per-word lighting

  if (style == 4) {
    // The wipe finishes at 0.86 of the line rather than at its end because the
    // cue is held past the last syllable (see Director.BuildTexts); running the
    // highlight to 1.0 would light the last word after it had been sung.
    float sung = smoothstep(f.word.order - 0.045, f.word.order + 0.045, k / 0.86);
    lit = mix(0.5, 1.0, sung);
    // 4x(1-x) peaks at the boundary, so the accent travels with the word being
    // sung instead of sitting on the whole line.
    glow = 4.0 * sung * (1.0 - sung) * (0.3 + 0.55 * uMidHit);
  } else if (style == 5) {
    float since = cascadeSince(f.word);
    float land = smoothstep(0.0, 0.5, since);
    a *= land;
    lit = mix(0.55, 1.0, land);
    glow = exp(-max(0.0, since) * 4.0) * 0.45 * uBeatStrength;
  } else if (style == 8) {
    lit = mix(0.8, 1.0, 0.5 + 0.5 * sin(uTime * 0.7 + f.word.rnd * TAU));
  }
  if (a < 0.004) { fragColor = vec4(base, 1.0); return; }

  // ------------------------------------------------------------- composite

  // Colour from the run's palette, cycling slowly so the text belongs to the
  // same world as the scene behind it.
  vec3 ink = pal(fract(uv.x * 0.35 + uTime * 0.06));
  ink = mix(ink, vec3(1.0), 0.45 + 0.25 * uBeatPulse);

  // The outline darkens the scene behind the glyph so the text survives a busy
  // plasma. It reaches outside the letters, not only into their own antialiased
  // rim, which is the difference between an outline and a slightly softer edge.
  vec3 outp = mix(base, base * 0.25, f.halo * a * 0.85);
  outp = mix(outp, ink * lit, f.mask * a);
  // The accent is added rather than mixed: a word being sung has to read as lit
  // from the inside, not as a slightly paler version of the one beside it.
  outp += ink * glow * a * (f.mask + f.halo * 0.3) * 0.65;

  fragColor = vec4(outp, 1.0);
}
