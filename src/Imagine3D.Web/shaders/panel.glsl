#include "common.glsl"

// 2D primitives for the instrument effects — meters, analysers, scopes.
//
// These are *distances*, not masks, so an edge is softened by comparing against
// the size of one pixel rather than by a fixed fraction of the shape. A needle
// then comes out two pixels wide at 1080p and two pixels wide at 4K, instead of
// aliasing at one resolution and smearing at the other. It is the same rule the
// README states for raster bars, applied to everything a panel is made of.
//
// fill() and stroke() take that softness explicitly because these shapes are
// usually drawn in a *local* space — inside a meter that has been scaled down to
// a quarter of the frame, or inside a glyph scaled down again. One pixel is a
// different number in each of those spaces, so passing it in is what keeps the
// anti-aliasing honest instead of silently over- or under-blurring.

/// One screen pixel, measured in the centred units centered() returns.
float pixel() { return 2.0 / uResolution.y; }

float sdBox2(vec2 p, vec2 b) {
  vec2 d = abs(p) - b;
  return length(max(d, 0.0)) + min(max(d.x, d.y), 0.0);
}

float sdRoundBox2(vec2 p, vec2 b, float r) {
  return sdBox2(p, b - r) - r;
}

float sdSegment2(vec2 p, vec2 a, vec2 b) {
  vec2 pa = p - a, ba = b - a;
  float h = clamp(dot(pa, ba) / max(1e-8, dot(ba, ba)), 0.0, 1.0);
  return length(pa - ba * h);
}

/// Distance to an arc of radius r about the origin, opening upward and reaching
/// `half_` radians either side of straight up. Beyond the ends it measures to the
/// end point, so a stroke around it gets round caps for free.
float sdArc2(vec2 p, float r, float half_) {
  float a = atan(p.x, p.y);
  if (abs(a) <= half_) return abs(length(p) - r);
  vec2 e = vec2(sin(half_) * r * sign(a), cos(half_) * r);
  return length(p - e);
}

/// Coverage of a filled shape: 1 inside, 0 outside, `aa` of softness at the edge.
float fill(float d, float aa) { return smoothstep(aa, -aa, d); }

/// Coverage of a line of half-width w along a shape's outline.
float stroke(float d, float w, float aa) { return fill(abs(d) - w, aa); }

/// Phosphor / LED falloff: a hot core inside `w` with an exponential halo around
/// it. Drawing a glowing trace as a hard line plus a separate bloom pass reads as
/// two things; this reads as one, which is what a lit thing actually looks like.
float glowLine(float d, float w, float spread, float aa) {
  return fill(d - w, max(aa, w * 0.6)) + exp(-max(0.0, d - w) / max(1e-4, spread)) * 0.85;
}

/// A band array read as one continuous curve over 0..1.
///
/// Every instrument here has to turn the band followers into "how loud is the
/// music a third of the way up the frame". Doing it in one place means they all
/// answer that the same way — and it is monotone in its inputs, which is what
/// lets a peak cap be drawn from the peak-hold followers and be guaranteed to
/// land at or above its own bar.
///
/// The bands are geometrically spaced, so t is an octave axis rather than a
/// linear frequency one: equal steps in t are equal musical intervals, and half
/// the curve is not spent on the top two octaves where music has little but
/// cymbals.
float bandCurve(float t, float a[BAND_COUNT]) {
  t = clamp(t, 0.0, 0.9999) * float(BAND_COUNT - 1);
  float k = smoothstep(0.0, 1.0, fract(t));
  int i = int(floor(t));
  return mix(a[i], a[min(i + 1, BAND_COUNT - 1)], k);
}

/// The spectrum now, from the lowest band at 0 to the highest at 1.
float spectrumNow(float t) { return bandCurve(t, uBands); }

/// The same curve on the peak-hold followers, so it never reads below spectrumNow().
float spectrumPeak(float t) { return bandCurve(t, uBandPeaks); }

/// Where the spectrum was just struck, rather than where it is loud. An effect
/// drawn from this flickers along with the percussion instead of swelling with
/// the mix.
float spectrumHit(float t) { return bandCurve(t, uBandHits); }

/// The shape of the spectrum: 0.5 is a band sitting at the average across all of
/// them, above is leaning into this part of the range, below is leaning out of
/// it. Independent of how loud the passage is.
float spectrumRel(float t) { return bandCurve(t, uBandRel); }
