// Named palettes. The storyboard picks one per video and every effect samples the
// same five stops through pal()/palClamp(), so one run reads as one colour world
// without any effect hard-coding a colour.

const hex = (s) => [
  parseInt(s.slice(1, 3), 16) / 255,
  parseInt(s.slice(3, 5), 16) / 255,
  parseInt(s.slice(5, 7), 16) / 255,
];

export const PALETTES = {
  // Cold, blue-white, high contrast. Suits dread/ritual material.
  frost: ['#04070f', '#123a5e', '#3f8fbf', '#a8dff0', '#f2fbff'],
  // Deep red through orange to white-hot.
  ember: ['#0a0300', '#4a1002', '#a83208', '#f08424', '#ffe6b0'],
  // Near-monochrome purple-black, for the quiet ominous passages.
  void: ['#05030a', '#1b1030', '#3d2266', '#7a4fb0', '#d6c2f0'],
  // Acid green industrial.
  toxic: ['#020a03', '#0d3312', '#2f8f2b', '#8fe03c', '#e8ffb0'],
  // Classic demoscene magenta/cyan neon.
  neon: ['#08020f', '#3d0a54', '#e0208c', '#20d0e0', '#ffffff'],
  sunset: ['#100418', '#4a1246', '#b2306a', '#f07850', '#ffd9a0'],
  candy: ['#12061a', '#5c1a72', '#c33ba8', '#ff8fd0', '#fff0fa'],
  // Greyscale with a blue-steel tint - the "vector demo" look.
  chrome: ['#050608', '#25303c', '#5d6f80', '#a8bccc', '#f0f6ff'],
};

export const PALETTE_NAMES = Object.keys(PALETTES);

/** Return five [r,g,b] stops for a palette name, falling back to frost. */
export function getPalette(name) {
  const stops = PALETTES[name] ?? PALETTES.frost;
  return stops.map(hex);
}
