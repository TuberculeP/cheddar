import {
  BoxGeometry,
  CanvasTexture,
  Group,
  Mesh,
  MeshBasicNodeMaterial,
  PlaneGeometry,
  PointLight,
  SRGBColorSpace,
} from "three/webgpu";
import { BEZEL, MONITOR, SCREEN, SCREEN_CENTER_Y, STAND } from "./config";
import { createPlasticMaterial } from "./materials";

const CANVAS_W = 1536;
const CANVAS_H = Math.round((CANVAS_W * SCREEN.height) / SCREEN.width);

/** Placeholder title layout: widest line, and the font size range it is fitted in. */
const TITLE_MAX_WIDTH = CANVAS_W * 0.82;
const TITLE_MAX_PX = 120;
const TITLE_MIN_PX = 56;
const TITLE_MAX_LINES = 3;

/**
 * Monitor body, stand, and the screen. The screen shows a 2D canvas used as a texture:
 * an uploaded image is drawn into it ("cover" fit), which also sidesteps the page's CSP
 * (no blob: URL is ever loaded). A point light in front of the screen takes the image's
 * average colour, so the cheese catches the glow.
 */
export class Monitor {
  readonly group = new Group();
  readonly screenLight = new PointLight(0xffffff, 0.35, 1.2, 2);
  private readonly canvas = document.createElement("canvas");
  private readonly ctx: CanvasRenderingContext2D;
  private readonly texture: CanvasTexture;
  private readonly disposables: { dispose(): void }[] = [];

  constructor(title: string) {
    this.canvas.width = CANVAS_W;
    this.canvas.height = CANVAS_H;
    const ctx = this.canvas.getContext("2d");
    if (!ctx) throw new Error("2D canvas unavailable");
    this.ctx = ctx;
    this.texture = new CanvasTexture(this.canvas);
    this.texture.colorSpace = SRGBColorSpace;
    this.texture.anisotropy = 4;

    const plastic = createPlasticMaterial(0x1c1d21, 0.55);
    const body = this.box(
      MONITOR.x1 - MONITOR.x0,
      MONITOR.y1 - MONITOR.y0,
      MONITOR.z1 - MONITOR.z0,
      plastic,
    );
    body.position.set(0, (MONITOR.y0 + MONITOR.y1) / 2, MONITOR.z0 / 2);

    const neck = this.boxFrom(STAND.neck, plastic);
    const base = this.boxFrom(STAND.base, plastic);
    neck.castShadow = base.castShadow = true;

    const screenGeometry = new PlaneGeometry(SCREEN.width, SCREEN.height);
    const screenMaterial = new MeshBasicNodeMaterial({ map: this.texture });
    screenMaterial.toneMapped = false;
    const screen = new Mesh(screenGeometry, screenMaterial);
    // A hair in front of the bezel face, behind the first cheese layer.
    screen.position.set(0, SCREEN_CENTER_Y, 0.00005);
    this.disposables.push(screenGeometry, screenMaterial, this.texture);

    const ledMaterial = new MeshBasicNodeMaterial({ color: 0x7dd3fc });
    const led = new Mesh(new BoxGeometry(0.004, 0.0015, 0.001), ledMaterial);
    led.position.set(MONITOR.x1 - 0.03, MONITOR.y0 + BEZEL.bottom / 2, 0.0005);
    this.disposables.push(led.geometry, ledMaterial, plastic);

    this.screenLight.position.set(0, SCREEN_CENTER_Y, 0.25);
    this.group.add(body, neck, base, screen, led, this.screenLight);
    this.drawPlaceholder(title);
  }

  /** Draws the image file onto the screen. Rejects if the file is not a decodable image. */
  async setImage(file: Blob) {
    const bitmap = await createImageBitmap(file);
    try {
      const scale = Math.max(CANVAS_W / bitmap.width, CANVAS_H / bitmap.height);
      const w = bitmap.width * scale;
      const h = bitmap.height * scale;
      this.ctx.fillStyle = "#000";
      this.ctx.fillRect(0, 0, CANVAS_W, CANVAS_H);
      this.ctx.drawImage(bitmap, (CANVAS_W - w) / 2, (CANVAS_H - h) / 2, w, h);
    } finally {
      bitmap.close();
    }
    this.refresh();
  }

  /**
   * Default screen, which doubles as the page title: a gradient wallpaper with the title
   * wrapped and sized to fit (largest font that keeps it within TITLE_MAX_LINES lines).
   */
  drawPlaceholder(title: string) {
    const ctx = this.ctx;
    const bg = ctx.createLinearGradient(0, 0, CANVAS_W, CANVAS_H);
    bg.addColorStop(0, "#1d3b6e");
    bg.addColorStop(1, "#5b2d6e");
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, CANVAS_W, CANVAS_H);
    ctx.fillStyle = "rgba(0,0,0,0.35)";
    ctx.fillRect(0, CANVAS_H - 60, CANVAS_W, 60);

    let size = TITLE_MAX_PX;
    let lines: string[] = [];
    for (; size >= TITLE_MIN_PX; size -= 4) {
      ctx.font = `bold ${size}px system-ui, sans-serif`;
      lines = wrap(ctx, title, TITLE_MAX_WIDTH);
      if (lines.length <= TITLE_MAX_LINES) break;
    }
    const lineHeight = size * 1.15;
    const top = (CANVAS_H - 60) / 2 - ((lines.length - 1) * lineHeight) / 2;
    ctx.fillStyle = "#fff";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    lines.forEach((line, i) =>
      ctx.fillText(line, CANVAS_W / 2, top + i * lineHeight),
    );
    this.refresh();
  }

  dispose() {
    for (const d of this.disposables) d.dispose();
  }

  private refresh() {
    this.texture.needsUpdate = true;
    // Average colour = the canvas shrunk to one pixel.
    const probe = document.createElement("canvas");
    probe.width = probe.height = 1;
    const pctx = probe.getContext("2d", { willReadFrequently: true });
    if (!pctx) return;
    pctx.drawImage(this.canvas, 0, 0, 1, 1);
    const [r, g, b] = pctx.getImageData(0, 0, 1, 1).data;
    this.screenLight.color.setRGB(r / 255, g / 255, b / 255, SRGBColorSpace);
  }

  private box(w: number, h: number, d: number, material: Disposable3D) {
    const geometry = new BoxGeometry(w, h, d);
    this.disposables.push(geometry);
    const mesh = new Mesh(geometry, material);
    mesh.receiveShadow = true;
    mesh.castShadow = true;
    return mesh;
  }

  private boxFrom(
    b: {
      x0: number;
      x1: number;
      y0: number;
      y1: number;
      z0: number;
      z1: number;
    },
    material: Disposable3D,
  ) {
    const mesh = this.box(b.x1 - b.x0, b.y1 - b.y0, b.z1 - b.z0, material);
    mesh.position.set((b.x0 + b.x1) / 2, (b.y0 + b.y1) / 2, (b.z0 + b.z1) / 2);
    return mesh;
  }
}

type Disposable3D = ReturnType<typeof createPlasticMaterial>;

/** Greedy word wrap with the context's current font. */
function wrap(ctx: CanvasRenderingContext2D, text: string, maxWidth: number) {
  const lines: string[] = [];
  let line = "";
  for (const word of text.split(/\s+/).filter(Boolean)) {
    const candidate = line ? `${line} ${word}` : word;
    if (line && ctx.measureText(candidate).width > maxWidth) {
      lines.push(line);
      line = word;
    } else {
      line = candidate;
    }
  }
  if (line) lines.push(line);
  return lines;
}
