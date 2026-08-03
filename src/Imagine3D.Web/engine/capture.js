// Browser side of the offline render.
//
// The server asks for exactly one frame at a time and waits for the pixels before
// asking for the next. That lockstep is what makes the output deterministic: frame
// N is always drawn at t = N/fps no matter how long it took to draw N-1.

import { Renderer } from './renderer.js';

export class CaptureClient {
  constructor({ onProgress, onStatus, onWarnings }) {
    this.onProgress = onProgress ?? (() => {});
    this.onStatus = onStatus ?? (() => {});
    this.onWarnings = onWarnings ?? (() => {});

    this.ws = null;
    this.renderer = null;
    this.job = null;
    this.project = null;

    this.thumbCanvas = document.createElement('canvas');
    this.thumbCanvas.width = 320;
    this.thumbCanvas.height = 180;
    this.thumbCtx = this.thumbCanvas.getContext('2d');
  }

  connect() {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const ws = new WebSocket(`${proto}://${location.host}/ws`);
    ws.binaryType = 'arraybuffer';
    this.ws = ws;

    ws.onopen = () => this.onStatus('connected');
    ws.onclose = () => {
      this.onStatus('disconnected');
      // The backend outlives the page only during a reload; retry so a refresh
      // during a run reattaches instead of silently going dead.
      setTimeout(() => this.connect(), 1500);
    };
    ws.onerror = () => this.onStatus('error');
    ws.onmessage = (ev) => this.handle(ev);

    return ws;
  }

  send(obj) {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(obj));
  }

  async handle(ev) {
    if (typeof ev.data !== 'string') return;

    let msg;
    try { msg = JSON.parse(ev.data); } catch { return; }

    try {
      switch (msg.cmd) {
        case 'hello':
          this.project = msg.project ?? this.project;
          break;
        case 'progress':
          this.onProgress(msg);
          break;
        case 'renderBegin':
          await this.begin(msg);
          break;
        case 'frame':
          await this.frame(msg);
          break;
        case 'snapshot':
          await this.snapshot(msg);
          break;
        case 'sheet':
          await this.sheet(msg);
          break;
        case 'reload':
          // ES modules are cached per document, so an edited engine file only
          // takes effect after a full document reload.
          location.reload();
          break;
        case 'renderEnd':
          this.end();
          break;
        default:
          break;
      }
    } catch (err) {
      console.error('[capture]', err);
      this.send({ type: 'error', message: String(err?.message ?? err) });
    }
  }

  async begin(job) {
    this.job = job;
    this.project = job.project;
    this.onStatus(`preparing ${job.width}x${job.height}`);

    this.disposeRenderer();
    const canvas = document.getElementById('render-canvas');
    this.renderer = new Renderer(canvas, job.width, job.height);

    if (this.renderer.info.software) {
      // Software WebGL turns a 4-minute video into an overnight job. Say so
      // loudly rather than letting it look like a hang.
      this.onWarnings([
        `WebGL is running on a software rasteriser (${this.renderer.info.renderer}). ` +
        'Rendering will be extremely slow. Check GPU acceleration in the webview.',
      ]);
    }

    const warnings = await this.loadProjectData(this.renderer, job.project);
    if (warnings.length) this.onWarnings(warnings);

    this.send({ type: 'ready', renderer: this.renderer.info.renderer });
  }

  async loadProjectData(renderer, project) {
    const [analysis, storyboard] = await Promise.all([
      fetch(`api/projects/${encodeURIComponent(project)}/analysis`).then((r) => {
        if (!r.ok) throw new Error('no analysis on disk - run the analyse step first');
        return r.json();
      }),
      fetch(`api/projects/${encodeURIComponent(project)}/storyboard`).then((r) => {
        if (!r.ok) throw new Error('no storyboard on disk');
        return r.json();
      }),
    ]);
    return renderer.load(analysis, storyboard, `media/${encodeURIComponent(project)}`);
  }

  async frame(msg) {
    if (!this.renderer || !this.job) throw new Error('frame requested before renderBegin');

    const t = msg.n / this.job.fps;
    this.renderer.renderAt(t);

    if (msg.thumb) {
      this.renderer.present();
      this.thumbCtx.drawImage(this.renderer.canvas, 0, 0,
        this.thumbCanvas.width, this.thumbCanvas.height);
      this.send({ type: 'thumb', data: this.thumbCanvas.toDataURL('image/jpeg', 0.5) });
    }

    const pixels = this.renderer.readPixels();
    // WebSocket.send copies the view synchronously, so reusing the buffer between
    // frames is safe and avoids an 8 MB allocation per frame.
    this.ws.send(pixels);
  }

  /** One-off frame used as an LTX init image, before the main render starts. */
  async snapshot(msg) {
    if (!this.renderer) {
      const canvas = document.getElementById('render-canvas');
      this.renderer = new Renderer(canvas, msg.width, msg.height);
      const warnings = await this.loadProjectData(this.renderer, this.project);
      if (warnings.length) this.onWarnings(warnings);
    }

    this.renderer.renderAt(msg.t);
    this.renderer.present();

    const blob = await new Promise((resolve) =>
      this.renderer.canvas.toBlob(resolve, 'image/png'));
    if (!blob) throw new Error('snapshot failed to encode');
    this.ws.send(await blob.arrayBuffer());
  }

  /** Dev tool: render the effect contact sheet on request from the backend. */
  async sheet(msg) {
    this.onStatus('rendering contact sheet');
    const { captureSheetToDisk } = await import('../ui/sheet.js');
    const result = await captureSheetToDisk({
      kind: msg.kind ?? 'all',
      palette: msg.palette ?? 'neon',
      onStatus: (s) => this.onStatus(`sheet ${s}`),
    });
    this.send({ type: 'sheetDone', ...result });
    this.onStatus('sheet saved');
  }

  end() {
    this.onStatus('render complete');
    this.job = null;
  }

  disposeRenderer() {
    this.renderer?.dispose();
    this.renderer = null;
  }
}
