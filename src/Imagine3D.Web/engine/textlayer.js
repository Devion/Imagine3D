// Lyric / scroller layer.
//
// Text is drawn white-on-transparent into a 2D canvas and uploaded as a texture;
// the compositing shader (effects/textcomposite) then colours and distorts it.
// That split is deliberate - it means the wavy-sine Amiga treatment, the slam and
// the fade are all shader work over one cheap, cached raster.

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
  }

  /** Pick the cue covering t, redraw only when the visible text actually changes. */
  update(cues, t) {
    const cue = cues.find((c) => t >= c.start && t < c.end) ?? null;
    this.active = cue;

    const key = cue ? `${cue.text}|${cue.style}` : '';
    if (key === this.lastKey) return cue;
    this.lastKey = key;

    const ctx = this.ctx;
    ctx.clearRect(0, 0, this.width, this.height);

    if (cue) {
      const lines = this.wrap(cue.text, Math.floor(this.width * 0.82));
      const size = this.fontSize(lines);
      ctx.font = `700 ${size}px "Segoe UI", system-ui, sans-serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillStyle = '#ffffff';

      const lineHeight = size * 1.18;
      const startY = this.height * 0.78 - ((lines.length - 1) * lineHeight) / 2;
      lines.forEach((line, i) => ctx.fillText(line, this.width / 2, startY + i * lineHeight));
    }

    const gl = this.gl;
    gl.bindTexture(gl.TEXTURE_2D, this.texture);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, this.canvas);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);

    return cue;
  }

  /** Scale text down as lines multiply so a long line never runs off frame. */
  fontSize(lines) {
    const base = Math.min(this.width, this.height) * 0.075;
    const longest = lines.reduce((n, l) => Math.max(n, l.length), 1);
    const fit = (this.width * 0.85) / (longest * 0.55);
    return Math.max(14, Math.min(base, fit));
  }

  wrap(text, maxPx) {
    const ctx = this.ctx;
    ctx.font = `700 ${Math.min(this.width, this.height) * 0.075}px "Segoe UI", system-ui, sans-serif`;
    const words = text.split(/\s+/);
    const lines = [];
    let line = '';
    for (const w of words) {
      const test = line ? `${line} ${w}` : w;
      if (ctx.measureText(test).width > maxPx && line) { lines.push(line); line = w; }
      else line = test;
    }
    if (line) lines.push(line);
    return lines.slice(0, 3);
  }

  dispose() { this.gl.deleteTexture(this.texture); }
}
