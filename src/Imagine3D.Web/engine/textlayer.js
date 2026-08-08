// Lyric / scroller layer.
//
// Text is drawn into a 2D canvas and uploaded as a texture; the compositing
// shader (effects/textcomposite) then colours and distorts it. That split is
// deliberate - it means the wavy-sine Amiga treatment, the slam and the fade are
// all shader work over one cheap, cached raster.
//
// The alpha channel is the glyph mask. The three colour channels are not colour:
// they carry, per word, where that word sits in the line's reading order, a
// stable random number of its own, and which wrapped row it is on. A shader with
// only a mask can treat the line as one object and nothing else, which is why
// every style here used to be a whole-line wave, slam or fade. An id per word is
// what lets it light the word being sung, drop the words in one per beat, or
// float each on its own phase - still one cached raster and still one pass.
//
// Reading the ids back is exact despite LINEAR filtering. The canvas is
// unpremultiplied on upload, so a texel half covered by a glyph arrives as
// (id*a, a): dividing the colour by the alpha recovers `id` unchanged, at the
// antialiased rim as well as in the solid middle. Words are separated by a fully
// transparent gap, so no two ids ever blend into one another.

const FONT = (size) => `700 ${size}px "Segoe UI", system-ui, sans-serif`;

/** 0..1 to one channel of an 8-bit colour. */
const byte = (v) => Math.round(Math.min(1, Math.max(0, v)) * 255);

/** Deterministic 0..1 from a number, so a word looks the same on every frame. */
function hash01(x) {
  const s = Math.sin(x * 12.9898) * 43758.5453;
  return s - Math.floor(s);
}

/**
 * Rasterise one lyric line, ids and all, into a 2D context sized w x h.
 * Returns the layout the shader needs to time itself against.
 *
 * Exported because the effect gallery draws its own sample line and has to draw
 * it the same way - a preview raster without ids previews a different shader.
 */
export function drawLyricRaster(ctx, text, w, h) {
  const rows = wrap(ctx, text, w, h, Math.floor(w * 0.82));
  if (rows.length === 0) return { words: 0, lines: 0 };

  const size = fontSize(rows, w, h);
  ctx.font = FONT(size);
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';

  // Reading order is measured in characters, not in words. "the" and
  // "everything" are one word each but nowhere near one beat each, and a wipe
  // stepped per word runs ahead of the singer through a long word and then
  // waits through a short one.
  const words = rows.flat();
  const chars = words.reduce((n, word) => n + word.length + 1, 0);
  const seed = text.length * 7.13;

  const space = ctx.measureText(' ').width;
  const lineHeight = size * 1.18;
  const startY = h * 0.78 - ((rows.length - 1) * lineHeight) / 2;

  let seen = 0;
  let index = 0;
  for (let li = 0; li < rows.length; li++) {
    const widths = rows[li].map((word) => ctx.measureText(word).width);
    const total = widths.reduce((a, b) => a + b, 0) + space * (rows[li].length - 1);
    let x = (w - total) / 2;
    const y = startY + li * lineHeight;

    for (let wi = 0; wi < rows[li].length; wi++) {
      const word = rows[li][wi];
      const r = byte(seen / Math.max(1, chars));
      const g = byte(hash01(index + seed));
      const b = byte((li + 0.5) / rows.length);
      ctx.fillStyle = `rgb(${r},${g},${b})`;
      ctx.fillText(word, x, y);

      x += widths[wi] + space;
      seen += word.length + 1;
      index++;
    }
  }

  return { words: words.length, lines: rows.length };
}

/** Break the line into rows of words that fit the frame, at most three. */
function wrap(ctx, text, w, h, maxPx) {
  ctx.font = FONT(Math.min(w, h) * 0.075);
  const words = text.split(/\s+/).filter(Boolean);
  const rows = [];
  let row = [];
  for (const word of words) {
    const test = row.length ? `${row.join(' ')} ${word}` : word;
    if (ctx.measureText(test).width > maxPx && row.length) { rows.push(row); row = [word]; }
    else row.push(word);
  }
  if (row.length) rows.push(row);
  return rows.slice(0, 3);
}

/** Scale text down as rows multiply so a long line never runs off frame. */
function fontSize(rows, w, h) {
  const base = Math.min(w, h) * 0.075;
  const longest = rows.reduce((n, row) => Math.max(n, row.join(' ').length), 1);
  const fit = (w * 0.85) / (longest * 0.55);
  return Math.max(14, Math.min(base, fit));
}

export class TextLayer {
  constructor(gl, width, height) {
    this.gl = gl;
    this.width = width;
    this.height = height;

    this.canvas = document.createElement('canvas');
    this.canvas.width = width;
    this.canvas.height = height;
    this.ctx = this.canvas.getContext('2d', { willReadFrequently: false });

    this.texture = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, this.texture);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, width, height, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

    this.lastKey = null;
    this.active = null;
    // Layout of whatever is currently rasterised. The renderer hands these to the
    // shader so a style can step through the words rather than through the line.
    this.words = 0;
    this.lines = 0;
  }

  /** Pick the cue covering t, redraw only when the visible text actually changes. */
  update(cues, t) {
    const cue = cues.find((c) => t >= c.start && t < c.end) ?? null;
    this.active = cue;

    const key = cue ? `${cue.text}|${cue.style}` : '';
    if (key === this.lastKey) return cue;
    this.lastKey = key;

    this.ctx.clearRect(0, 0, this.width, this.height);
    const layout = cue
      ? drawLyricRaster(this.ctx, cue.text, this.width, this.height)
      : { words: 0, lines: 0 };
    this.words = layout.words;
    this.lines = layout.lines;

    const gl = this.gl;
    gl.bindTexture(gl.TEXTURE_2D, this.texture);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
    // Premultiplied, which is what makes the ids readable at all.
    //
    // Uploaded unpremultiplied, the browser has to divide the canvas's own
    // premultiplied store back out, and where the alpha is zero there is nothing
    // to divide by - those texels arrive carrying colour rather than the
    // transparent black they were cleared to. The filter then mixes that colour
    // into every rim texel of every glyph, and rgb/a comes back saturated: a
    // phantom word ordered after all the real ones, which a word-by-word style
    // will sit and wait for. Premultiplied is also simply the correct form to
    // interpolate: a rim texel is (id*coverage, coverage), so the divide in
    // wordAt() is exact rather than approximate.
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, this.canvas);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);

    return cue;
  }

  dispose() { this.gl.deleteTexture(this.texture); }
}
