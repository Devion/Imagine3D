#include "common.glsl"
#include "palette.glsl"

// The text raster arrives white-on-transparent from engine/textlayer.js; all the
// character comes from what happens here.
//
// uAmount carries the style index (0 wave, 1 slam, 2 fade, 3 scroll) and cueT is
// 0..1 through the line's own lifetime.

void main() {
  int style = int(uAmount + 0.5);
  float k = clamp(p_cue, 0.0, 1.0);

  vec2 uv = vUv;
  float alpha = 1.0;
  float scale = 1.0;

  if (style == 0) {
    // Per-column sine offset - the classic wavy scroller. Amplitude rides the
    // bass so the text breathes with the track.
    float amp = 0.012 + 0.02 * uBass;
    uv.y += sin(uv.x * 9.0 + uTime * 2.4) * amp;
    uv.x += sin(uv.y * 5.0 - uTime * 1.1) * amp * 0.4;
    alpha = smoothstep(0.0, 0.12, k) * smoothstep(0.0, 0.18, 1.0 - k);
  } else if (style == 1) {
    // Slam: punches in oversized on the beat and settles.
    scale = 1.0 + 0.35 * exp(-k * 14.0) + 0.06 * uBeatPulse;
    uv = (uv - 0.5) / scale + 0.5;
    alpha = smoothstep(0.0, 0.05, k) * smoothstep(0.0, 0.25, 1.0 - k);
  } else if (style == 2) {
    alpha = smoothstep(0.0, 0.3, k) * smoothstep(0.0, 0.35, 1.0 - k) * 0.85;
  } else {
    // Scroll right-to-left across the frame.
    uv.x += k * 1.6 - 0.8;
    uv.y += sin(uv.x * 7.0 + uTime * 2.0) * 0.01;
    alpha = 1.0;
  }

  vec3 base = texture(uPrev, vUv).rgb;
  if (uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0) {
    fragColor = vec4(base, 1.0);
    return;
  }

  float mask = texture(uText, uv).a;
  if (mask < 0.01) { fragColor = vec4(base, 1.0); return; }

  // Colour from the run's palette, cycling slowly so the text belongs to the
  // same world as the scene behind it.
  vec3 ink = pal(fract(uv.x * 0.35 + uTime * 0.06));
  ink = mix(ink, vec3(1.0), 0.45 + 0.25 * uBeatPulse);

  // Cheap outline: sample the mask a few texels out and darken behind the glyph
  // so text stays legible over a busy plasma.
  vec2 px = 2.2 / uResolution;
  float halo = 0.0;
  halo = max(halo, texture(uText, uv + vec2( px.x, 0.0)).a);
  halo = max(halo, texture(uText, uv + vec2(-px.x, 0.0)).a);
  halo = max(halo, texture(uText, uv + vec2(0.0,  px.y)).a);
  halo = max(halo, texture(uText, uv + vec2(0.0, -px.y)).a);

  vec3 outp = mix(base, base * 0.25, halo * alpha * 0.85);
  outp = mix(outp, ink, mask * alpha);

  fragColor = vec4(outp, 1.0);
}
