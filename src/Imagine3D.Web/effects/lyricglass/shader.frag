#include "common.glsl"
#include "noise.glsl"
#include "palette.glsl"

// The lyric line as a slab of glass.
//
// The text raster from engine/textlayer.js is a hard-edged alpha mask, which is
// no use as a lens - what a lens needs is thickness and a surface normal. Both
// come out of one gather: sample the mask on a golden-angle spiral and keep two
// running sums. The weighted alpha is the thickness; the weighted *offset* is a
// vector pointing into the covered region, which is the surface normal for free.
// Doing it as two separate blurs would cost three more gathers for the gradient
// alone.
//
// This pass deliberately never draws the glyphs. effects/textcomposite still runs
// after it and puts the readable text on top; this only gives it a body.

const int TAPS = 16;
const float GOLDEN = 2.39996323;

struct Glass { float thick; vec2 grad; };

Glass gather(vec2 uv, float radius, float aspect) {
  Glass g;
  g.thick = texture(uText, uv).a;
  g.grad = vec2(0.0);
  float wsum = 1.0;

  for (int i = 1; i <= TAPS; i++) {
    float f = float(i) / float(TAPS);
    float a = float(i) * GOLDEN;
    // sqrt(f) spaces the samples evenly over the disc rather than bunching them
    // at the centre; the aspect divide keeps the disc round in pixels.
    vec2 o = vec2(cos(a) / aspect, sin(a)) * radius * sqrt(f);
    float w = 1.0 - f * 0.7;
    float s = texture(uText, uv + o).a * w;
    g.thick += s;
    g.grad += o * s;
    wsum += w;
  }

  g.thick /= wsum;
  g.grad /= wsum * radius;
  return g;
}

void main() {
  vec2 uv = vUv;
  float amount = clamp(uAmount, 0.0, 1.0);
  vec3 src = texture(uPrev, uv).rgb;

  float mask = texture(uText, uv).a;
  float radius = p_spread * 0.045;

  // Molten edge: warping the lookup rather than the result keeps the glass a
  // solid body instead of putting a wobble on top of a clean shape.
  float wob = (fbm(uv * 6.0 + vec2(0.0, uTime * 0.35), 3, 2.1, 0.55) - 0.5) * 0.012;
  Glass g = gather(uv + wob, radius, uAspect);

  if (g.thick < 0.002) { fragColor = vec4(src, 1.0); return; }

  // The line swells as it lands and relaxes as it leaves.
  float k = clamp(p_cue, 0.0, 1.0);
  float swell = smoothstep(0.0, 0.12, k) * smoothstep(1.0, 0.72, k);

  // Strongest at the rim, where a real lens bends light hardest and the middle
  // of the glyph stays close to flat.
  float rimness = 4.0 * g.thick * (1.0 - g.thick);
  vec2 n = -g.grad;

  float bend = p_refract * 0.05 * amount * (0.7 + 0.5 * swell);
  vec2 off = n * bend * rimness;

  // Heat ripple. The thickness field falls off with distance from the letters,
  // so a sine of it comes out as rings around them at no extra cost.
  off += n * sin(g.thick * 42.0 - uTime * 5.5) * (1.0 - g.thick) * g.thick
       * p_shimmer * 0.05 * amount;

  // Dispersion: the channels take slightly different paths through the glass.
  vec3 col;
  col.r = texture(uPrev, uv + off * 1.12).r;
  col.g = texture(uPrev, uv + off).g;
  col.b = texture(uPrev, uv + off * 0.88).b;

  // Contact shadow. Sampling the mask displaced *against* the light gives the
  // shadow the glass casts, and it is the cheapest way to lift the letters off
  // the scene instead of leaving them embedded in it.
  vec2 sunOff = vec2(0.009 / uAspect, -0.013);
  float shadow = texture(uText, uv - sunOff).a;
  col *= 1.0 - 0.5 * sat(shadow - mask) * amount * swell;

  // Rim light along the edge of the letters.
  float edge = pow(sat(length(g.grad) * 4.5), 2.0);
  vec3 tint = pal(fract(uv.x * 0.3 + uTime * 0.05));
  col += mix(tint, vec3(1.0), 0.45) * edge * p_rim * amount * swell * 1.3;

  // Specular. The gathered gradient is the slope of the surface; giving it a
  // fixed z turns it into a facing normal with something to catch a highlight
  // on, which is what finally reads as glass rather than as a smudge.
  vec3 sn = normalize(vec3(n * 2.6, 0.7));
  float spec = pow(sat(dot(sn, normalize(vec3(-0.45, 0.62, 0.65)))), 22.0);
  col += vec3(1.0) * spec * rimness * p_rim * amount * swell * 1.5;

  // Body glow, so the glass carries some of the palette rather than being clear.
  col += tint * g.thick * g.thick * p_glow * 0.6 * amount * swell;

  fragColor = vec4(mix(src, col, amount), 1.0);
}
