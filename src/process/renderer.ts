/**
 * Draws one output frame: a source photo warped by its alignment transform,
 * colour-matched in OKLab through per-channel lookup tables, with an optional
 * vignette and caption. WebGL2 does it per pixel on the GPU; a Canvas 2D
 * fallback covers devices without WebGL2 (colour correction is then baked
 * into each source image once, on the CPU).
 */
import { applyLuts, BINS, RANGES } from '../core/color';
import type { Sim } from '../core/geometry';

export type Luts = [Float32Array, Float32Array, Float32Array];
export type RenderSource = ImageBitmap | HTMLCanvasElement | OffscreenCanvas | HTMLImageElement;

export interface DrawOptions {
  /** 0 (none) … 1 (strong) */
  vignette: number;
  caption: boolean;
}

export interface FrameRenderer {
  readonly kind: 'webgl2' | 'canvas2d';
  readonly canvas: HTMLCanvasElement | OffscreenCanvas;
  resize(width: number, height: number): void;
  setSource(key: string, source: RenderSource): void;
  hasSource(key: string): boolean;
  setLuts(key: string, luts: Luts | null): void;
  setCaption(caption: HTMLCanvasElement | OffscreenCanvas | null): void;
  draw(key: string, sim: Sim, opts: DrawOptions): void;
  dispose(): void;
}

const VS = `#version 300 es
in vec2 aPos;
in vec2 aUv;
uniform vec2 uSize;
out vec2 vUv;
out vec2 vPos;
void main() {
  vUv = aUv;
  vPos = aPos;
  vec2 clip = aPos / uSize * 2.0 - 1.0;
  gl_Position = vec4(clip.x, -clip.y, 0.0, 1.0);
}`;

const FS = `#version 300 es
precision highp float;
in vec2 vUv;
in vec2 vPos;
uniform sampler2D uTex;
uniform highp sampler2D uLut;
uniform bool uUseLut;
uniform vec2 uSize;
uniform float uVignette;
out vec4 outColor;

vec3 toLinear(vec3 c) {
  return mix(c / 12.92, pow((c + 0.055) / 1.055, vec3(2.4)), step(vec3(0.04045), c));
}
vec3 toSrgb(vec3 x) {
  x = clamp(x, 0.0, 1.0);
  return mix(12.92 * x, 1.055 * pow(x, vec3(1.0 / 2.4)) - 0.055, step(vec3(0.0031308), x));
}
vec3 toOklab(vec3 c) {
  float l = 0.4122214708 * c.r + 0.5363325363 * c.g + 0.0514459929 * c.b;
  float m = 0.2119034982 * c.r + 0.6806995451 * c.g + 0.1073969566 * c.b;
  float s = 0.0883024619 * c.r + 0.2817188376 * c.g + 0.6299787005 * c.b;
  l = pow(max(l, 0.0), 1.0 / 3.0); m = pow(max(m, 0.0), 1.0 / 3.0); s = pow(max(s, 0.0), 1.0 / 3.0);
  return vec3(
    0.2104542553 * l + 0.7936177850 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.4285922050 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.8086757660 * s);
}
vec3 fromOklab(vec3 c) {
  float l = c.x + 0.3963377774 * c.y + 0.2158037573 * c.z;
  float m = c.x - 0.1055613458 * c.y - 0.0638541728 * c.z;
  float s = c.x - 0.0894841775 * c.y - 1.2914855480 * c.z;
  l = l * l * l; m = m * m * m; s = s * s * s;
  return vec3(
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.7076147010 * s);
}
float lut(int row, float v, float lo, float hi) {
  float bins = ${BINS}.0;
  float x = (v - lo) / (hi - lo) * bins - 0.5;
  float width = (hi - lo) / bins;
  if (x <= 0.0) return texelFetch(uLut, ivec2(0, row), 0).r + (v - (lo + 0.5 * width));
  if (x >= bins - 1.0) return texelFetch(uLut, ivec2(${BINS - 1}, row), 0).r + (v - (hi - 0.5 * width));
  int i = int(floor(x));
  float f = x - float(i);
  return mix(texelFetch(uLut, ivec2(i, row), 0).r, texelFetch(uLut, ivec2(i + 1, row), 0).r, f);
}
void main() {
  vec3 c = texture(uTex, vUv).rgb;
  if (uUseLut) {
    vec3 lab = toOklab(toLinear(c));
    lab = vec3(
      lut(0, lab.x, ${RANGES[0][0].toFixed(4)}, ${RANGES[0][1].toFixed(4)}),
      lut(1, lab.y, ${RANGES[1][0].toFixed(4)}, ${RANGES[1][1].toFixed(4)}),
      lut(2, lab.z, ${RANGES[2][0].toFixed(4)}, ${RANGES[2][1].toFixed(4)}));
    c = toSrgb(fromOklab(lab));
  }
  if (uVignette > 0.0) {
    vec2 q = vPos / uSize - 0.5;
    float r = length(q) * 1.41421356;
    c *= 1.0 - uVignette * smoothstep(0.35, 1.05, r);
  }
  outColor = vec4(c, 1.0);
}`;

const OVERLAY_FS = `#version 300 es
precision mediump float;
in vec2 vUv;
in vec2 vPos;
uniform sampler2D uTex;
out vec4 outColor;
void main() { outColor = texture(uTex, vUv); }`;

function compile(gl: WebGL2RenderingContext, type: number, src: string): WebGLShader {
  const sh = gl.createShader(type)!;
  gl.shaderSource(sh, src);
  gl.compileShader(sh);
  if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(sh) ?? 'shader error');
  return sh;
}

function program(gl: WebGL2RenderingContext, fs: string): WebGLProgram {
  const p = gl.createProgram()!;
  gl.attachShader(p, compile(gl, gl.VERTEX_SHADER, VS));
  gl.attachShader(p, compile(gl, gl.FRAGMENT_SHADER, fs));
  gl.bindAttribLocation(p, 0, 'aPos');
  gl.bindAttribLocation(p, 1, 'aUv');
  gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p) ?? 'link error');
  return p;
}

function sourceSize(s: RenderSource): [number, number] {
  if (s instanceof HTMLImageElement) return [s.naturalWidth, s.naturalHeight];
  return [s.width, s.height];
}

class GLRenderer implements FrameRenderer {
  readonly kind = 'webgl2' as const;
  private readonly main: WebGLProgram;
  private readonly overlay: WebGLProgram;
  private readonly buf: WebGLBuffer;
  private readonly vao: WebGLVertexArrayObject;
  private readonly textures = new Map<string, { tex: WebGLTexture; w: number; h: number }>();
  private readonly luts = new Map<string, WebGLTexture>();
  private caption: WebGLTexture | null = null;
  private width = 2;
  private height = 2;

  constructor(
    readonly canvas: HTMLCanvasElement | OffscreenCanvas,
    private readonly gl: WebGL2RenderingContext,
  ) {
    this.main = program(gl, FS);
    this.overlay = program(gl, OVERLAY_FS);
    this.buf = gl.createBuffer()!;
    this.vao = gl.createVertexArray()!;
    gl.bindVertexArray(this.vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.buf);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 16, 0);
    gl.enableVertexAttribArray(1);
    gl.vertexAttribPointer(1, 2, gl.FLOAT, false, 16, 8);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
  }

  resize(width: number, height: number): void {
    this.width = width;
    this.height = height;
    if (this.canvas.width !== width) this.canvas.width = width;
    if (this.canvas.height !== height) this.canvas.height = height;
  }

  hasSource(key: string): boolean {
    return this.textures.has(key);
  }

  setSource(key: string, source: RenderSource): void {
    const gl = this.gl;
    let entry = this.textures.get(key);
    if (!entry) {
      entry = { tex: gl.createTexture()!, w: 0, h: 0 };
      this.textures.set(key, entry);
    }
    [entry.w, entry.h] = sourceSize(source);
    gl.bindTexture(gl.TEXTURE_2D, entry.tex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, source as TexImageSource);
    gl.generateMipmap(gl.TEXTURE_2D);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  }

  setLuts(key: string, luts: Luts | null): void {
    const gl = this.gl;
    const old = this.luts.get(key);
    if (!luts) {
      if (old) gl.deleteTexture(old);
      this.luts.delete(key);
      return;
    }
    const data = new Float32Array(BINS * 3);
    data.set(luts[0], 0);
    data.set(luts[1], BINS);
    data.set(luts[2], 2 * BINS);
    const tex = old ?? gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.R32F, BINS, 3, 0, gl.RED, gl.FLOAT, data);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 4);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    this.luts.set(key, tex);
  }

  setCaption(caption: HTMLCanvasElement | OffscreenCanvas | null): void {
    const gl = this.gl;
    if (!caption) {
      if (this.caption) gl.deleteTexture(this.caption);
      this.caption = null;
      return;
    }
    this.caption ??= gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, this.caption);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, caption);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  }

  private quad(corners: [number, number][], uvs: [number, number][]): void {
    const gl = this.gl;
    const v = new Float32Array(16);
    const order = [0, 1, 3, 2]; // triangle strip: TL, TR, BL, BR
    order.forEach((c, i) => {
      v[i * 4] = corners[c][0];
      v[i * 4 + 1] = corners[c][1];
      v[i * 4 + 2] = uvs[c][0];
      v[i * 4 + 3] = uvs[c][1];
    });
    gl.bindBuffer(gl.ARRAY_BUFFER, this.buf);
    gl.bufferData(gl.ARRAY_BUFFER, v, gl.DYNAMIC_DRAW);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  }

  draw(key: string, s: Sim, opts: DrawOptions): void {
    const gl = this.gl;
    const entry = this.textures.get(key);
    gl.viewport(0, 0, this.width, this.height);
    gl.bindVertexArray(this.vao);
    gl.disable(gl.BLEND);
    gl.clearColor(0, 0, 0, 1);
    gl.clear(gl.COLOR_BUFFER_BIT);
    if (entry) {
      gl.useProgram(this.main);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, entry.tex);
      gl.uniform1i(gl.getUniformLocation(this.main, 'uTex'), 0);
      const lut = this.luts.get(key);
      gl.activeTexture(gl.TEXTURE1);
      gl.bindTexture(gl.TEXTURE_2D, lut ?? null);
      gl.uniform1i(gl.getUniformLocation(this.main, 'uLut'), 1);
      gl.uniform1i(gl.getUniformLocation(this.main, 'uUseLut'), lut ? 1 : 0);
      gl.uniform2f(gl.getUniformLocation(this.main, 'uSize'), this.width, this.height);
      gl.uniform1f(gl.getUniformLocation(this.main, 'uVignette'), opts.vignette);
      const map = (x: number, y: number): [number, number] => [s.a * x - s.b * y + s.tx, s.b * x + s.a * y + s.ty];
      this.quad(
        [map(0, 0), map(entry.w, 0), map(entry.w, entry.h), map(0, entry.h)],
        [
          [0, 0],
          [1, 0],
          [1, 1],
          [0, 1],
        ],
      );
    }
    if (opts.caption && this.caption) {
      gl.useProgram(this.overlay);
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, this.caption);
      gl.uniform1i(gl.getUniformLocation(this.overlay, 'uTex'), 0);
      gl.uniform2f(gl.getUniformLocation(this.overlay, 'uSize'), this.width, this.height);
      this.quad(
        [
          [0, 0],
          [this.width, 0],
          [this.width, this.height],
          [0, this.height],
        ],
        [
          [0, 0],
          [1, 0],
          [1, 1],
          [0, 1],
        ],
      );
      gl.disable(gl.BLEND);
    }
  }

  dispose(): void {
    const gl = this.gl;
    for (const t of this.textures.values()) gl.deleteTexture(t.tex);
    for (const t of this.luts.values()) gl.deleteTexture(t);
    if (this.caption) gl.deleteTexture(this.caption);
    this.textures.clear();
    this.luts.clear();
    gl.deleteBuffer(this.buf);
    gl.deleteVertexArray(this.vao);
    gl.deleteProgram(this.main);
    gl.deleteProgram(this.overlay);
  }
}

type Ctx2D = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;

class Canvas2DRenderer implements FrameRenderer {
  readonly kind = 'canvas2d' as const;
  private readonly sources = new Map<string, RenderSource>();
  private readonly corrected = new Map<string, HTMLCanvasElement | OffscreenCanvas>();
  private readonly luts = new Map<string, Luts>();
  private caption: HTMLCanvasElement | OffscreenCanvas | null = null;

  constructor(
    readonly canvas: HTMLCanvasElement | OffscreenCanvas,
    private readonly ctx: Ctx2D,
  ) {}

  resize(width: number, height: number): void {
    if (this.canvas.width !== width) this.canvas.width = width;
    if (this.canvas.height !== height) this.canvas.height = height;
  }

  hasSource(key: string): boolean {
    return this.sources.has(key);
  }

  setSource(key: string, source: RenderSource): void {
    this.sources.set(key, source);
    this.corrected.delete(key);
  }

  setLuts(key: string, luts: Luts | null): void {
    if (luts) this.luts.set(key, luts);
    else this.luts.delete(key);
    this.corrected.delete(key);
  }

  setCaption(caption: HTMLCanvasElement | OffscreenCanvas | null): void {
    this.caption = caption;
  }

  /** Colour correction baked into a copy of the source (slow, done once per change). */
  private image(key: string): CanvasImageSource | null {
    const src = this.sources.get(key);
    if (!src) return null;
    const luts = this.luts.get(key);
    if (!luts) return src as CanvasImageSource;
    let out = this.corrected.get(key);
    if (!out) {
      const [w, h] = sourceSize(src);
      out =
        typeof OffscreenCanvas !== 'undefined'
          ? new OffscreenCanvas(w, h)
          : Object.assign(document.createElement('canvas'), { width: w, height: h });
      const c = out.getContext('2d') as Ctx2D;
      c.drawImage(src as CanvasImageSource, 0, 0);
      const img = c.getImageData(0, 0, w, h);
      applyLuts(img.data, luts);
      c.putImageData(img, 0, 0);
      this.corrected.set(key, out);
    }
    return out as CanvasImageSource;
  }

  draw(key: string, s: Sim, opts: DrawOptions): void {
    const { ctx, canvas } = this;
    const w = canvas.width;
    const h = canvas.height;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, w, h);
    const img = this.image(key);
    if (img) {
      ctx.setTransform(s.a, s.b, -s.b, s.a, s.tx, s.ty);
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(img, 0, 0);
      ctx.setTransform(1, 0, 0, 1, 0, 0);
    }
    if (opts.vignette > 0) {
      const r = Math.hypot(w, h) / 2;
      const g = ctx.createRadialGradient(w / 2, h / 2, r * 0.35, w / 2, h / 2, r * 1.05);
      g.addColorStop(0, 'rgba(0,0,0,0)');
      g.addColorStop(1, `rgba(0,0,0,${opts.vignette})`);
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, w, h);
    }
    if (opts.caption && this.caption) ctx.drawImage(this.caption as CanvasImageSource, 0, 0, w, h);
  }

  dispose(): void {
    this.sources.clear();
    this.corrected.clear();
  }
}

/** Prefer WebGL2; fall back to Canvas 2D. */
export function createRenderer(canvas: HTMLCanvasElement | OffscreenCanvas, opts: { forceCanvas2d?: boolean } = {}): FrameRenderer {
  if (!opts.forceCanvas2d) {
    try {
      const gl = canvas.getContext('webgl2', {
        alpha: false,
        antialias: false,
        premultipliedAlpha: false,
        preserveDrawingBuffer: true,
      }) as WebGL2RenderingContext | null;
      if (gl) return new GLRenderer(canvas, gl);
    } catch (err) {
      console.warn('WebGL2 renderer unavailable, using Canvas 2D', err);
    }
  }
  const ctx = canvas.getContext('2d', { alpha: false }) as Ctx2D | null;
  if (!ctx) throw new Error('This browser cannot draw images.');
  return new Canvas2DRenderer(canvas, ctx);
}

/** A transparent overlay with a small "frozen moment · date" caption. */
export function makeCaption(width: number, height: number, text: string): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = width;
  c.height = height;
  const ctx = c.getContext('2d')!;
  const size = Math.round(Math.min(width, height) * 0.032);
  ctx.font = `600 ${size}px system-ui, -apple-system, "Segoe UI", Roboto, sans-serif`;
  ctx.textBaseline = 'alphabetic';
  ctx.fillStyle = 'rgba(247, 242, 234, 0.88)';
  ctx.shadowColor = 'rgba(0,0,0,0.55)';
  ctx.shadowBlur = size * 0.6;
  const letter = text.toUpperCase().split('').join(String.fromCharCode(8202));
  ctx.fillText(letter, Math.round(size * 1.2), Math.round(height - size * 1.4));
  return c;
}
