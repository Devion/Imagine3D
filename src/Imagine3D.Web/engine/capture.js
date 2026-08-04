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
    this.loadedProject = null;
    this.job = null;
    // Identifies the run the page is currently serving. The server stamps it on
    // every command and we stamp it on every reply, so a run that was cancelled
    // or timed out can never be mistaken for the one now in progress.
    this.runId = null;
    this.project = null;

    // Commands are handled strictly in order. begin() awaits fetches and shader
    // compiles, and onmessage keeps firing during those awaits - without this
    // queue a frame can be drawn on a renderer that is still being built.
    this.queue = Promise.resolve();

    this.thumbCanvas = document.createElement('canvas');
    this.thumbCanvas.width = 320;
    this.thumbCanvas.height = 180;
    this.thumbCtx = this.thumbCanvas.getContext('2d');
  }

  connect() {
    // A late reconnect timer must not stack a second socket on a live one: the
    // backend tracks one channel per page and would start talking to the newer
    // socket halfway through a render on the older one.
    if (this.ws && (this.ws.readyState === WebSocket.OPEN ||
                    this.ws.readyState === WebSocket.CONNECTING)) return this.ws;

    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const ws = new WebSocket(`${proto}://${location.host}/ws`);
    ws.binaryType = 'arraybuffer';
    this.ws = ws;

    ws.onopen = () => this.onStatus('connected');
    ws.onclose = () => {
      this.onStatus('disconnected');
      // Whatever run this socket was serving is gone with it.
      this.job = null;
      this.runId = null;
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

  handle(ev) {
    if (typeof ev.data !== 'string') return;

    let msg;
    try { msg = JSON.parse(ev.data); } catch { return; }

    this.queue = this.queue.then(() => this.dispatch(msg)).catch((err) => {
      console.error('[capture]', err);
      // Tagged with the run it belongs to so the backend fails the right render.
      this.send({ type: 'error', runId: this.runId, message: String(err?.message ?? err) });
    });
  }

  async dispatch(msg) {
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
  }

  async begin(job) {
    // Not ready until the renderer holds this run's storyboard: `ready` is the
    // page's promise that the very next frame command can be drawn.
    this.job = null;
    this.runId = job.runId ?? null;
    this.project = job.project;
    this.onStatus(`preparing ${job.width}x${job.height}`);

    // A storyboard can change between runs, so always rebuild rather than reuse.
    this.disposeRenderer();
    const renderer = await this.buildRenderer(job.width, job.height, job.project);

    this.job = job;
    this.send({ type: 'ready', runId: this.runId, renderer: renderer.info.renderer });
  }

  /**
   * Build a renderer and load the project into it. `this.renderer` is only
   * published once it can actually draw - a half-loaded renderer has no
   * storyboard, and drawing on one is the failure this guards.
   */
  async buildRenderer(width, height, project) {
    const canvas = document.getElementById('render-canvas');
    const renderer = new Renderer(canvas, width, height);

    if (renderer.info.software) {
      // Software WebGL turns a 4-minute video into an overnight job. Say so
      // loudly rather than letting it look like a hang.
      this.onWarnings([
        `WebGL is running on a software rasteriser (${renderer.info.renderer}). ` +
        'Rendering will be extremely slow. Check GPU acceleration in the webview.',
      ]);
    }

    const warnings = await this.loadProjectData(renderer, project);
    if (warnings.length) this.onWarnings(warnings);

    this.renderer = renderer;
    this.loadedProject = project;
    return renderer;
  }

  /** The renderer for `project`, building one if there is none or it is stale. */
  async ensureRenderer(width, height, project) {
    if (this.renderer && this.loadedProject === project) return this.renderer;
    this.disposeRenderer();
    return this.buildRenderer(width, height, project);
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
    if (!storyboard?.scenes) throw new Error('storyboard.json has no scenes');
    return renderer.load(analysis, storyboard, `media/${encodeURIComponent(project)}`);
  }

  async frame(msg) {
    // Answer a superseded run directly rather than throwing: that run fails at
    // once with a reason instead of waiting out its frame timeout, and the run
    // this page is actually serving carries on untouched.
    if (msg.runId && this.runId && msg.runId !== this.runId) {
      this.send({
        type: 'error',
        runId: msg.runId,
        message: `render ${msg.runId} was superseded by ${this.runId}`,
      });
      return;
    }

    if (!this.renderer || !this.job) throw new Error('frame requested before renderBegin');

    const t = msg.n / this.job.fps;
    // An LTX clip has to be decoded to the right frame before anything samples
    // it; renderAt() itself cannot wait, so the seek is awaited here.
    await this.renderer.prepareAt(t);
    this.renderer.renderAt(t);

    if (msg.thumb) {
      this.renderer.present();
      this.thumbCtx.drawImage(this.renderer.canvas, 0, 0,
        this.thumbCanvas.width, this.thumbCanvas.height);
      this.send({ type: 'thumb', runId: this.runId, data: this.thumbCanvas.toDataURL('image/jpeg', 0.5) });
    }

    const pixels = this.renderer.readPixels();
    // WebSocket.send copies the view synchronously, so reusing the buffer between
    // frames is safe and avoids an 8 MB allocation per frame.
    this.ws.send(pixels);
  }

  /** One-off frame used as an LTX init image, before the main render starts. */
  async snapshot(msg) {
    const renderer = await this.ensureRenderer(msg.width, msg.height, this.project);

    await renderer.prepareAt(msg.t);
    renderer.renderAt(msg.t);
    renderer.present();

    const blob = await new Promise((resolve) => renderer.canvas.toBlob(resolve, 'image/png'));
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
    this.runId = null;
    // Hand back the GPU memory the render held. The next run builds a fresh
    // renderer from what is on disk then, which is also what makes a re-render
    // pick up an edited storyboard.
    this.disposeRenderer();
  }

  disposeRenderer() {
    this.renderer?.dispose();
    this.renderer = null;
    this.loadedProject = null;
  }
}
