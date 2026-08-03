#include "common.glsl"

// Video feedback. uFeedback is the previous finished frame, so zooming and
// rotating it before mixing gives the endless-tunnel echo a physical camera
// pointed at its own monitor produces.

void main() {
  vec3 current = texture(uPrev, vUv).rgb;

  // Transform about the centre so the echo spirals inward or outward.
  vec2 c = vUv - 0.5;
  c = rot(p_rotate) * c / max(0.001, p_zoom);
  vec2 fbUv = c + 0.5;

  vec3 old = vec3(0.0);
  if (fbUv.x > 0.0 && fbUv.x < 1.0 && fbUv.y > 0.0 && fbUv.y < 1.0)
    old = texture(uFeedback, fbUv).rgb;

  // Rotate the echo's hue a little each generation, so trails drift through the
  // spectrum instead of just dimming.
  if (abs(p_hueShift) > 1e-5) {
    vec3 hsv = rgb2hsv(old);
    hsv.x = fract(hsv.x + p_hueShift);
    old = hsv2rgb(hsv);
  }

  vec3 trail = old * p_decay;

  // Lighten-blend rather than mix: the current frame stays crisp on top of its
  // own history instead of being washed out by it.
  vec3 outp = max(current, trail);
  fragColor = vec4(mix(current, outp, clamp(uAmount, 0.0, 1.0)), 1.0);
}
