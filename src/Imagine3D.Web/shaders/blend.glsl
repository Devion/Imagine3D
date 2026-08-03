// Blend modes, including the ones the brief asks for by name (MUL, XOR).
// Used for compositing LTX clips over the demo and for layering post passes.

vec3 blendNormal(vec3 b, vec3 s)     { return s; }
vec3 blendAdd(vec3 b, vec3 s)        { return min(vec3(1.0), b + s); }
vec3 blendMultiply(vec3 b, vec3 s)   { return b * s; }
vec3 blendScreen(vec3 b, vec3 s)     { return 1.0 - (1.0 - b) * (1.0 - s); }
vec3 blendDifference(vec3 b, vec3 s) { return abs(b - s); }
vec3 blendSubtract(vec3 b, vec3 s)   { return max(vec3(0.0), b - s); }
vec3 blendLighten(vec3 b, vec3 s)    { return max(b, s); }
vec3 blendDarken(vec3 b, vec3 s)     { return min(b, s); }

vec3 blendOverlay(vec3 b, vec3 s) {
  return mix(2.0 * b * s, 1.0 - 2.0 * (1.0 - b) * (1.0 - s), step(0.5, b));
}

vec3 blendHardLight(vec3 b, vec3 s) { return blendOverlay(s, b); }

vec3 blendSoftLight(vec3 b, vec3 s) {
  return mix(2.0 * b * s + b * b * (1.0 - 2.0 * s),
             sqrt(b) * (2.0 * s - 1.0) + 2.0 * b * (1.0 - s),
             step(0.5, s));
}

vec3 blendDodge(vec3 b, vec3 s) { return b / max(vec3(1e-3), 1.0 - s); }
vec3 blendBurn(vec3 b, vec3 s)  { return 1.0 - (1.0 - b) / max(vec3(1e-3), s); }

// True bitwise XOR on the 8-bit quantisation of each channel. This is the effect
// that actually looks like an Amiga blitter op rather than a modern compositor -
// it produces hard banded interference instead of a smooth mix.
vec3 blendXor(vec3 b, vec3 s) {
  ivec3 bi = ivec3(clamp(b, 0.0, 1.0) * 255.0);
  ivec3 si = ivec3(clamp(s, 0.0, 1.0) * 255.0);
  return vec3(bi ^ si) / 255.0;
}

vec3 blendAnd(vec3 b, vec3 s) {
  ivec3 bi = ivec3(clamp(b, 0.0, 1.0) * 255.0);
  ivec3 si = ivec3(clamp(s, 0.0, 1.0) * 255.0);
  return vec3(bi & si) / 255.0;
}

vec3 blendOr(vec3 b, vec3 s) {
  ivec3 bi = ivec3(clamp(b, 0.0, 1.0) * 255.0);
  ivec3 si = ivec3(clamp(s, 0.0, 1.0) * 255.0);
  return vec3(bi | si) / 255.0;
}

/// Dispatch by the mode index the renderer passes in (see BLEND_MODES in
/// engine/renderer.js - the order must match).
vec3 blendMode(int mode, vec3 base, vec3 src) {
  if (mode == 1)  return blendAdd(base, src);
  if (mode == 2)  return blendMultiply(base, src);
  if (mode == 3)  return blendScreen(base, src);
  if (mode == 4)  return blendDifference(base, src);
  if (mode == 5)  return blendOverlay(base, src);
  if (mode == 6)  return blendXor(base, src);
  if (mode == 7)  return blendSubtract(base, src);
  if (mode == 8)  return blendLighten(base, src);
  if (mode == 9)  return blendDarken(base, src);
  if (mode == 10) return blendDodge(base, src);
  if (mode == 11) return blendBurn(base, src);
  if (mode == 12) return blendSoftLight(base, src);
  if (mode == 13) return blendAnd(base, src);
  if (mode == 14) return blendOr(base, src);
  return src;
}
