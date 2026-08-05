#include "common.glsl"
#include "palette.glsl"
#include "panel.glsl"

// The scope, opened out into depth: the live trace at the front and every
// earlier one still standing behind it, receding, rising and twisting away into
// a grid floor. A scope's persistence, made spatial.
//
// There is no sample-accurate audio in the analysis — it carries envelopes at
// about 43 Hz — so the trace is resynthesised from six partials whose amplitudes
// are the six band followers. That is also what makes the depth possible: the
// waveform is a *function* of time, not a recording, so the trace as it stood a
// second ago can simply be evaluated rather than stored. Every layer here is the
// same honest picture of the spectrum at its own moment, which is exactly what a
// stored history would have been.
//
// Nothing is marched. Each layer is a plane at a known depth, so the projection
// inverts in closed form: a screen point maps to one point on that plane, and
// the curve's screen-space gradient turns out to equal its world gradient, which
// is what keeps the beam one width wide from the front of the stack to the back.
// A layer whose trace cannot reach this pixel is rejected before its six sines
// are ever evaluated, which is what pays for forty of them.

const float Z0 = 0.85;     // depth of the live trace
const float DZ = 0.42;     // world spacing between layers

// How far each layer sits above the one in front. Perspective makes this
// converge rather than climb: the stack heads for RISE * F / DZ up the screen
// however many layers there are, so it wants to be small or the vanishing point
// leaves the frame through the top.
const float RISE = 0.038;

/// One partial and its exact slope. Analytic rather than sampled: the beam width
/// is divided by the local gradient to hold it constant on screen, and
/// finite-differencing that would double the sines per layer per pixel.
void partial(float a, float f, float drift, float phase, float x, float t,
             inout float y, inout float slope) {
  float k = f * TAU;
  float s = k * x + drift * t + phase;
  y += a * sin(s);
  slope += a * k * cos(s);
}

// 1, 2, 4, 7, 13, 23 rather than a harmonic series: with integer octaves the sum
// repeats exactly along the trace and reads as a test pattern. They are weighted
// down as they rise because a real waveform is a big slow shape with fine detail
// riding on it, not six equal sines.
void traceAt(float x, float t, out float y, out float slope) {
  y = 0.0;
  slope = 0.0;
  partial(uSub    * 1.00,  1.0, 0.7, 0.0, x, t, y, slope);
  partial(uBass   * 0.90,  2.0, 1.3, 1.1, x, t, y, slope);
  partial(uLowMid * 0.60,  4.0, 2.1, 2.3, x, t, y, slope);
  partial(uMid    * 0.40,  7.0, 3.4, 0.7, x, t, y, slope);
  partial(uHigh   * 0.22, 13.0, 5.5, 3.9, x, t, y, slope);
  partial(uAir    * 0.12, 23.0, 8.9, 5.2, x, t, y, slope);
}

void main() {
  vec2 p = centered(vUv, uAspect);
  float aa = pixel();

  // Camera. A slow roll that never quite repeats, tightened by a kick on the
  // bar, and a focal length that pushes in on the beat - the two moves that make
  // a still object feel handheld rather than mounted.
  float roll = sin(uTime * 0.11) * 0.07 + sin(uTime * 0.043) * 0.04;
  roll += uBarPulse * 0.025 * p_twist;
  p = rot(roll) * p;
  p += vec2(sin(uTime * 0.19) * 0.04, -0.05 + sin(uTime * 0.13) * 0.03);

  float F = 1.35 + 0.12 * uBeatPulse;

  vec3 phos = mix(vec3(0.28, 1.00, 0.42), palClamp(0.72), p_tint);
  vec3 col = vec3(0.004, 0.008, 0.007);

  // --- the floor the stack stands over ------------------------------------
  // A ground plane gives the depth something to be measured against; without it
  // the layers read as concentric rings rather than as a corridor.
  vec3 rd = normalize(vec3(p, F));
  if (rd.y < -1e-3) {
    float tHit = -0.62 / rd.y;
    vec3 w = rd * tHit;
    vec2 cellPos = vec2(w.x, w.z + uTime * 0.35) * 1.1;
    vec2 gl = abs(fract(cellPos + 0.5) - 0.5);

    // The line has to widen with distance or the far field turns to moire. This
    // is a linear stand-in for the true footprint, which grows faster; the fog
    // below covers where it stops being enough.
    float lw = clamp(0.010 * tHit, 0.010, 0.45);
    float line = smoothstep(lw, 0.0, min(gl.x, gl.y));
    col += mix(phos, palClamp(0.55), 0.6) * line * exp(-tHit * 0.10) * 0.30;
  }

  // Haze toward the vanishing point, so the far end of the stack has somewhere
  // to go instead of just stopping.
  col += palClamp(0.45) * exp(-length(p - vec2(0.0, 0.06)) * 2.2) * 0.10 * p_glow;

  // --- the stack ----------------------------------------------------------
  int layers = int(clamp(p_layers, 2.0, 48.0));
  float t0 = uTime * p_speed;
  float dt = 0.045 * p_persist;
  float gain = 0.16 * p_amp;

  // One layer's worth of in-plane rotation, composed round the loop rather than
  // recomputed - forty cos/sin pairs per pixel is a real cost for two constants.
  float twist = p_twist * 0.016;
  vec2 step_ = vec2(cos(twist), sin(twist));
  vec2 turn = vec2(1.0, 0.0);

  for (int k = 0; k < 48; k++) {
    if (k >= layers) break;
    float fk = float(k);
    float zk = Z0 + fk * DZ;
    float s = F / zk;                       // world -> screen at this depth

    // Screen point back onto this layer's plane, then out of the layer's own
    // rotation about the view axis.
    vec2 w = p / s - vec2(0.0, fk * RISE);
    vec2 q = vec2(turn.x * w.x + turn.y * w.y, turn.x * w.y - turn.y * w.x);
    turn = vec2(turn.x * step_.x - turn.y * step_.y, turn.x * step_.y + turn.y * step_.x);

    // Everything above is a handful of multiplies. The six sines below are the
    // expensive part, so a layer that cannot possibly reach this pixel is thrown
    // out first: the trace is bounded, and so is the glow around it.
    if (abs(q.y) > gain * 1.8 + 0.035 / s) continue;

    float y, slope;
    traceAt(q.x, t0 - fk * dt, y, slope);
    y *= gain;
    slope *= gain;

    // Perpendicular distance, converted to screen. Dividing by the gradient is
    // what keeps the line one width wide instead of fattening where it is steep.
    float g = inversesqrt(1.0 + slope * slope);
    float d = abs(q.y - y) * g * s;

    float bw = 0.0020 * p_beam * mix(1.0, 0.45, fk / float(layers));
    // The gun writes more charge where it dwells, so a steep edge comes out
    // dimmer than a flat top - and depth takes the rest.
    float bright = exp(-fk * 0.085) * (0.35 + 0.65 * g);
    vec3 c = mix(phos, palClamp(0.20 + 0.65 * fk / float(layers)), 0.25 + 0.55 * fk / float(layers));

    col += c * glowLine(d, bw, bw * 3.2, aa) * bright;
  }

  col *= p_glow * (0.90 + 0.45 * uBeatPulse);

  // --- the glass ----------------------------------------------------------
  col *= 0.90 + 0.10 * sin(vUv.y * uResolution.y * PI);
  // Quantised to 24 Hz so the tube hisses at the same rate whatever the render
  // frame rate is.
  col *= 0.96 + 0.07 * hash12(floor(vUv * uResolution) + floor(uTime * 24.0) * 37.0);
  col *= 1.0 - 0.40 * pow(clamp(length(centered(vUv, uAspect) * vec2(0.55, 0.85)), 0.0, 1.0), 2.2);

  fragColor = vec4(max(col, 0.0), 1.0);
}
