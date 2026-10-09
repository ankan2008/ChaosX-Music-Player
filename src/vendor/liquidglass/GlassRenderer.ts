/**
 * GlassRenderer — WebGL rendering pipeline for the liquid glass effect.
 *
 * Manages a single offscreen WebGL canvas, shader programs, and a pool
 * of local-sized FBOs for blur passes. Each panel render crops just the
 * padded region behind that panel, uploads only that region, and shades
 * the glass effect into the matching per-element canvas.
 *
 * The pool is an allocation cache and nothing more — every target in it is
 * rewritten before it is read — so it is bounded by `FBO_POOL_BUDGET_BYTES` and
 * trimmed from outside when surfaces go away. It used not to be, which is how
 * this class came to be the largest single holder of GPU memory in the app.
 */

import { VS_QUAD, FS_BLIT, FS_BLUR, VS_GLASS, FS_GLASS } from './shaders';
import { BLUR_ITERATIONS, SHADOW_PAD } from './defaults';
import type { GlassConfig } from './defaults';

interface FBO {
	fbo: WebGLFramebuffer;
	tex: WebGLTexture;
	w: number;
	h: number;
}

interface FBOSet {
	bg: FBO;
	blurA: FBO;
	blurB: FBO;
	/** Incremented on every use; only here so the pool can evict least-recently-used. */
	stamp: number;
	/** `w * h * 4 * 3`, the bytes this set holds on the GPU. */
	bytes: number;
}

type UniformMap = Record<string, WebGLUniformLocation | null>;

/**
 * How many distinct render-target sizes the pool may hold.
 *
 * Each entry is three full RGBA textures — the backdrop, and the two blur
 * ping-pong buffers — for one exact surface size, so a single library card at
 * 1903x974 costs ~22 MB and a set of panels of a dozen different sizes costs
 * whatever they add up to. The pool used to be a pure cache: entries were only
 * ever dropped by `resize()` (a window resize), by a WebGL context restore, or
 * by `destroy()`. Nothing in a session that never resizes the window — a card
 * that grows when a playlist opens, a sheet that resizes with its content, a
 * takeover that comes and goes — ever released anything, so every size a surface
 * has *ever* had stayed resident. That is the shape of the measured GPU process:
 * 386 MB working set, unmoved by Small Potato Mode, with ~11 MB of actual canvas
 * pixels in the document to account for it.
 *
 * What bounds it now is `trimTo()`, which the engine calls with the sizes the
 * surfaces being painted actually have, and that is deliberately the only eviction:
 * an evict that can fire *while* a frame is being rendered is not a memory bound, it
 * is an allocation storm. This app paints twenty-some surfaces of twenty-some
 * different sizes, so a tight cap or a byte budget would evict a set on almost every
 * panel and re-allocate three textures — tens of megabytes — every frame, costing
 * frames to save memory the page genuinely needs. A ceiling has to sit above the
 * page's real working set to be free at all, and shrinking the working set is
 * `renderScale`'s job, not this constant's. Forty-eight is the valve for the size set
 * going wrong: a surface resizing every frame, a panel that will not settle, where
 * the trim cannot keep up on its own.
 *
 * Evicting is free in every other currency. A set is written in full before it is
 * read on every panel render — `bg` by the blit, `blurA` by the copy, `blurB` by the
 * first blur pass — and nothing carries over between panels, so the cache is an
 * allocation pool, not state. Dropping an entry means the next panel of that size
 * allocates it again; the pixels are identical either way.
 */
const FBO_POOL_MAX_SETS = 48;

export class GlassRenderer {
	readonly canvas: HTMLCanvasElement;
	readonly gl: WebGLRenderingContext;
	private readonly cropCanvas: HTMLCanvasElement;
	private readonly cropCtx: CanvasRenderingContext2D;

	private blitP!: WebGLProgram;
	private blitU!: UniformMap;
	private blurP!: WebGLProgram;
	private blurU!: UniformMap;
	private glassP!: WebGLProgram;
	private glassU!: UniformMap;

	private quadBuf!: WebGLBuffer;
	private panelBuf!: WebGLBuffer;

	private readonly fboCache = new Map<string, FBOSet>();
	private activeFBOs: FBOSet | null = null;
	private activeKey = '';
	private poolBytes = 0;
	private poolStamp = 0;

	private bgTex: WebGLTexture | null = null;

	width = 0;
	height = 0;

	/**
	 * Device pixels per *render-target* pixel, as a fraction of the surface's CSS
	 * geometry — 1 whenever the targets are at native resolution.
	 *
	 * It is set by `resize()` from the caller's render scale and used only to keep
	 * the hand-authored pixel constants in the shaders and the blur radius honest
	 * when the targets are smaller than the display. See `LiquidGlass.renderScale`.
	 */
	pxScale = 1;

	contextLost = false;

	private _onContextLost: (e: Event) => void;
	private _onContextRestored: () => void;

	constructor() {
		this.canvas = document.createElement('canvas');
		this.canvas.style.display = 'none';
		document.body.appendChild(this.canvas);
		this.cropCanvas = document.createElement('canvas');
		this.cropCtx = this.cropCanvas.getContext('2d')!;

		const gl = this.canvas.getContext('webgl', {
			alpha: true,
			premultipliedAlpha: false,
			antialias: false,
			preserveDrawingBuffer: true,
		});

		if (!gl) {
			throw new Error('LiquidGlass: WebGL is not supported in this browser.');
		}
		this.gl = gl;

		this._initPrograms();
		this._initBuffers();

		this._onContextLost = (e: Event) => {
			e.preventDefault();
			this.contextLost = true;
			console.warn('LiquidGlass: WebGL context lost.');
		};
		this._onContextRestored = () => {
			console.info('LiquidGlass: WebGL context restored — reinitialising.');
			this.contextLost = false;
			this._initPrograms();
			this._initBuffers();
			for (const fboSet of this.fboCache.values()) {
				this._freeFBOSet(fboSet);
			}
			this.fboCache.clear();
			this.poolBytes = 0;
			this.activeFBOs = null;
			this.activeKey = '';
			this.bgTex = null;
		};
		this.canvas.addEventListener('webglcontextlost', this._onContextLost);
		this.canvas.addEventListener('webglcontextrestored', this._onContextRestored);
	}

	// ────────────────────────────────────────────
	// Initialisation
	// ────────────────────────────────────────────

	private _initPrograms(): void {
		this.blitP = this._link(VS_QUAD, FS_BLIT);
		this.blitU = this._uloc(this.blitP, ['u_tex', 'u_scale', 'u_offset']);

		this.blurP = this._link(VS_QUAD, FS_BLUR);
		this.blurU = this._uloc(this.blurP, ['u_tex', 'u_dir']);

		this.glassP = this._link(VS_GLASS, FS_GLASS);
		this.glassU = this._uloc(this.glassP, [
			'u_bgTex', 'u_blurTex', 'u_center', 'u_size', 'u_radius',
			'u_res', 'u_pad', 'u_refract', 'u_chroma',
			'u_edgeHL', 'u_spec', 'u_fresnel', 'u_distort', 'u_alpha',
			'u_sat', 'u_tint', 'u_zRadius', 'u_brightness',
			'u_shadowAlpha', 'u_shadowSpread', 'u_shadowOffY',
			'u_bevelMode', 'u_pxScale',
		]);
	}

	private _initBuffers(): void {
		const gl = this.gl;

		this.quadBuf = gl.createBuffer()!;
		gl.bindBuffer(gl.ARRAY_BUFFER, this.quadBuf);
		gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);

		this.panelBuf = gl.createBuffer()!;
		gl.bindBuffer(gl.ARRAY_BUFFER, this.panelBuf);
		gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-.5, -.5, .5, -.5, -.5, .5, .5, .5]), gl.STATIC_DRAW);
	}

	// ────────────────────────────────────────────
	// Resize
	// ────────────────────────────────────────────

	resize(width: number, height: number, pxScale = 1): void {
		this.width = width;
		this.height = height;
		this.pxScale = pxScale;
		// Panel sizes change on resize — flush the FBO pool so stale
		// entries don't accumulate and the canvas can shrink.
		for (const fboSet of this.fboCache.values()) {
			this._freeFBOSet(fboSet);
		}
		this.fboCache.clear();
		this.poolBytes = 0;
		this.activeFBOs = null;
		this.activeKey = '';
		this.canvas.width = 0;
		this.canvas.height = 0;
		// The crop canvas is resized to the panel on every upload, so nothing here
		// needs its old pixels, and leaving it sized means the largest surface in
		// the session's history keeps a full RGBA backing store until the next
		// upload happens to overwrite it.
		this.cropCanvas.width = 0;
		this.cropCanvas.height = 0;
	}

	/**
	 * Forget every cached render target whose size no live surface uses, and shrink
	 * the shared drawing buffers to the biggest surface that is left.
	 *
	 * Called from the engine's reap pass, which only runs when the set of live
	 * surfaces has actually changed — never per frame. Both buffers are
	 * grow-only for a reason (`_prepareSceneCanvas`'s comment records what resizing
	 * on every panel costs), so this is the only place they come back down: a
	 * takeover's full-window surfaces leaving the page would otherwise hold the
	 * whole allocation for the rest of the session.
	 *
	 * Safe because neither buffer's contents survive a panel render: every target
	 * is cleared and written in full before the panel that reads it copies it out.
	 */
	trimTo(liveSizes: Set<string>, maxW: number, maxH: number): void {
		for (const [key, fboSet] of [...this.fboCache]) {
			if (liveSizes.has(key)) continue;
			if (key === this.activeKey) continue;
			this._freeFBOSet(fboSet);
			this.fboCache.delete(key);
			this.poolBytes -= fboSet.bytes;
		}
		if (this.canvas.width > maxW && maxW > 0) this.canvas.width = maxW;
		if (this.canvas.height > maxH && maxH > 0) this.canvas.height = maxH;
		if (this.cropCanvas.width > maxW && maxW > 0) this.cropCanvas.width = maxW;
		if (this.cropCanvas.height > maxH && maxH > 0) this.cropCanvas.height = maxH;
	}

	/** Bytes held by the render-target pool, for the engine's own reporting. */
	get poolBytesHeld(): number {
		return this.poolBytes;
	}

	// ────────────────────────────────────────────
	// Background upload
	// ────────────────────────────────────────────

	uploadAndBlur(
		sourceCanvas: HTMLCanvasElement,
		sourceX: number,
		sourceY: number,
		width: number,
		height: number,
		blurAmount: number,
	): void {
		if (this.contextLost) return;
		const gl = this.gl;
		if (!this._setActiveSize(width, height)) return;
		const W = this.width;
		const H = this.height;
		const fboSet = this.activeFBOs!;

		this.cropCanvas.width = W;
		this.cropCanvas.height = H;
		this.cropCtx.clearRect(0, 0, W, H);
		this.cropCtx.drawImage(sourceCanvas, -sourceX, -sourceY);

		if (!this.bgTex) {
			this.bgTex = gl.createTexture();
		}
		gl.bindTexture(gl.TEXTURE_2D, this.bgTex);
		gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true as unknown as number);
		gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, this.cropCanvas);
		gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
		gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
		gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
		gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
		gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false as unknown as number);

		// Blit source → bgFBO (local padded region)
		gl.bindFramebuffer(gl.FRAMEBUFFER, fboSet.bg.fbo);
		gl.viewport(0, 0, W, H);
		gl.useProgram(this.blitP);
		gl.activeTexture(gl.TEXTURE0);
		gl.bindTexture(gl.TEXTURE_2D, this.bgTex);
		gl.uniform1i(this.blitU.u_tex, 0);
		gl.uniform2f(this.blitU.u_scale, 1, 1);
		gl.uniform2f(this.blitU.u_offset, 0, 0);
		this._drawQuad(this.blitP, this.quadBuf);

		// Copy bgFBO → blurA (u_scale/u_offset are already (1,1)/(0,0))
		const bw = fboSet.blurA.w;
		const bh = fboSet.blurA.h;
		gl.bindFramebuffer(gl.FRAMEBUFFER, fboSet.blurA.fbo);
		gl.viewport(0, 0, bw, bh);
		gl.bindTexture(gl.TEXTURE_2D, fboSet.bg.tex);
		this._drawQuad(this.blitP, this.quadBuf);

		// Multi-pass Gaussian blur (skip entirely when not needed)
		if (blurAmount > 0) {
			/*
			 * `spread` is a tap offset in render-target pixels, and the target is
			 * stretched back to the panel's CSS box at composite time, so an
			 * unscaled constant would make the frost deepen as the target shrinks —
			 * 0.7x resolution would blur 1.43x harder. Scaling it by the same factor
			 * keeps the radius the same number of CSS pixels whatever the target.
			 */
			const spread = blurAmount * 2.5 * this.pxScale;
			gl.useProgram(this.blurP);
			gl.uniform1i(this.blurU.u_tex, 0);
			for (let i = 0; i < BLUR_ITERATIONS; i++) {
				gl.bindFramebuffer(gl.FRAMEBUFFER, fboSet.blurB.fbo);
				gl.viewport(0, 0, bw, bh);
				gl.bindTexture(gl.TEXTURE_2D, fboSet.blurA.tex);
				gl.uniform2f(this.blurU.u_dir, spread / bw, 0);
				this._drawQuad(this.blurP, this.quadBuf);

				gl.bindFramebuffer(gl.FRAMEBUFFER, fboSet.blurA.fbo);
				gl.bindTexture(gl.TEXTURE_2D, fboSet.blurB.tex);
				gl.uniform2f(this.blurU.u_dir, 0, spread / bh);
				this._drawQuad(this.blurP, this.quadBuf);
			}
		}
	}

	// ────────────────────────────────────────────
	// Glass panel rendering
	// ────────────────────────────────────────────

	renderGlassPanel(
		config: GlassConfig,
		width: number,
		height: number,
		dpr: number,
	): void {
		if (this.contextLost) return;
		const gl = this.gl;
		const W = this.width;
		const H = this.height;
		const fboSet = this.activeFBOs!;

		gl.enable(gl.BLEND);
		gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
		gl.useProgram(this.glassP);

		gl.activeTexture(gl.TEXTURE0);
		gl.bindTexture(gl.TEXTURE_2D, fboSet.bg.tex);
		gl.uniform1i(this.glassU.u_bgTex, 0);
		gl.activeTexture(gl.TEXTURE1);
		gl.bindTexture(gl.TEXTURE_2D, fboSet.blurA.tex);
		gl.uniform1i(this.glassU.u_blurTex, 1);

		gl.bindFramebuffer(gl.FRAMEBUFFER, null);
		gl.viewport(0, this.canvas.height - H, W, H);
		gl.uniform2f(this.glassU.u_res, W, H);

		gl.uniform2f(this.glassU.u_center, W * 0.5, H * 0.5);
		gl.uniform2f(this.glassU.u_size, width * dpr, height * dpr);

		gl.uniform1f(this.glassU.u_radius, config.cornerRadius * dpr);
		gl.uniform1f(this.glassU.u_pad, SHADOW_PAD * dpr);
		gl.uniform1f(this.glassU.u_refract, config.refraction);
		gl.uniform1f(this.glassU.u_chroma, config.chromAberration);
		gl.uniform1f(this.glassU.u_edgeHL, config.edgeHighlight);
		gl.uniform1f(this.glassU.u_spec, config.specular);
		gl.uniform1f(this.glassU.u_fresnel, config.fresnel);
		gl.uniform1f(this.glassU.u_distort, config.distortion);
		gl.uniform1f(this.glassU.u_alpha, config.opacity);
		gl.uniform1f(this.glassU.u_sat, config.saturation);
		gl.uniform1f(this.glassU.u_tint, config.tintStrength);
		gl.uniform1f(this.glassU.u_zRadius, config.zRadius * dpr);
		gl.uniform1f(this.glassU.u_brightness, config.brightness);
		gl.uniform1f(this.glassU.u_shadowAlpha, config.shadowOpacity);
		gl.uniform1f(this.glassU.u_shadowSpread, config.shadowSpread * dpr);
		gl.uniform1f(this.glassU.u_shadowOffY, config.shadowOffsetY * dpr);
		gl.uniform1f(this.glassU.u_bevelMode, config.bevelMode);
		/*
		 * The panel's own geometry arrives already multiplied by the scaled dpr, so
		 * it needs nothing here. What does need it is every pixel constant written
		 * by hand inside the fragment shader — the anti-aliasing band, the inner
		 * stroke width, the refraction reach, the chromatic-aberration spread —
		 * because those are authored in render-target pixels and would each cover a
		 * larger slice of the panel as the target shrinks. 1.0 is exact in float, so
		 * at the default scale this changes not one bit of the output.
		 */
		gl.uniform1f(this.glassU.u_pxScale, this.pxScale);

		this._drawQuad(this.glassP, this.panelBuf);
		gl.disable(gl.BLEND);
	}

	clear(): void {
		const gl = this.gl;
		gl.bindFramebuffer(gl.FRAMEBUFFER, null);
		gl.viewport(0, this.canvas.height - this.height, this.width, this.height);
		gl.enable(gl.SCISSOR_TEST);
		gl.scissor(0, this.canvas.height - this.height, this.width, this.height);
		gl.clearColor(0, 0, 0, 0);
		gl.clear(gl.COLOR_BUFFER_BIT);
		gl.disable(gl.SCISSOR_TEST);
	}

	destroy(): void {
		this.canvas.removeEventListener('webglcontextlost', this._onContextLost);
		this.canvas.removeEventListener('webglcontextrestored', this._onContextRestored);
		if (!this.contextLost) {
			const gl = this.gl;
			for (const fboSet of this.fboCache.values()) {
				this._freeFBOSet(fboSet);
			}
			this.fboCache.clear();
			this.poolBytes = 0;
			if (this.bgTex) gl.deleteTexture(this.bgTex);
			gl.deleteBuffer(this.quadBuf);
			gl.deleteBuffer(this.panelBuf);
			gl.deleteProgram(this.blitP);
			gl.deleteProgram(this.blurP);
			gl.deleteProgram(this.glassP);
			/*
			 * Then ask the driver to take the context itself down.
			 *
			 * Deleting every object in the pool empties the pool; it does not close the
			 * context, and the context — its drawing buffer, its command queue, its
			 * driver-side allocation — belongs to the canvas element and survives the
			 * element leaving the document until the garbage collector gets round to the
			 * element. That is why entering Small Potato Mode, which destroys this whole
			 * pipeline, moved the GPU process by 2 MB out of 386. `loseContext()` is the
			 * only call in WebGL that gives those bytes back on the caller's schedule,
			 * and it is safe precisely because it is last: the listeners are already
			 * detached, so the context-lost handler cannot fire and re-upload anything,
			 * and nothing else holds this renderer after `destroy()` returns.
			 */
			gl.getExtension('WEBGL_lose_context')?.loseContext();
		}
		this.activeFBOs = null;
		this.activeKey = '';
		this.bgTex = null;
		this.cropCanvas.width = 0;
		this.cropCanvas.height = 0;
		this.canvas.width = 0;
		this.canvas.height = 0;
		this.canvas.remove();
	}

	// ────────────────────────────────────────────
	// FBO management
	// ────────────────────────────────────────────

	private _setActiveSize(w: number, h: number): boolean {
		if (w <= 0 || h <= 0) return false;

		this.width = w;
		this.height = h;

		if (this.canvas.width < w || this.canvas.height < h) {
			this.canvas.width = Math.max(this.canvas.width, w);
			this.canvas.height = Math.max(this.canvas.height, h);
		}

		const key = `${w}x${h}`;
		let fboSet = this.fboCache.get(key);
		if (!fboSet) {
			fboSet = {
				bg: this._makeFBO(w, h),
				blurA: this._makeFBO(w, h),
				blurB: this._makeFBO(w, h),
				stamp: 0,
				bytes: w * h * 4 * 3,
			};
			this.fboCache.set(key, fboSet);
			this.poolBytes += fboSet.bytes;
		}
		fboSet.stamp = ++this.poolStamp;
		this.activeFBOs = fboSet;
		this.activeKey = key;
		if (this.fboCache.size > 1) this._trimPool(key);
		return true;
	}

	/**
	 * Keep the pool under its valve.
	 *
	 * The set that is active right now is never evicted — the panel that is
	 * mid-render owns it. Everything else goes least-recently-used first, and the
	 * whole exercise only exists for a size set that has run away: the real bound is
	 * `trimTo()`, which the engine calls with the surfaces it is actually painting.
	 */
	private _trimPool(keepKey: string): void {
		if (this.fboCache.size <= FBO_POOL_MAX_SETS) return;
		const order = [...this.fboCache.entries()]
			.filter(([key]) => key !== keepKey)
			.sort((a, b) => a[1].stamp - b[1].stamp);
		for (const [key, fboSet] of order) {
			if (this.fboCache.size <= FBO_POOL_MAX_SETS) break;
			this._freeFBOSet(fboSet);
			this.fboCache.delete(key);
			this.poolBytes -= fboSet.bytes;
		}
	}

	private _makeFBO(w: number, h: number): FBO {
		const gl = this.gl;
		const tex = gl.createTexture()!;
		gl.bindTexture(gl.TEXTURE_2D, tex);
		gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
		gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
		gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
		gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
		gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

		const fbo = gl.createFramebuffer()!;
		gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
		gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
		gl.bindFramebuffer(gl.FRAMEBUFFER, null);

		return { fbo, tex, w, h };
	}

	private _freeFBO(fboObj: FBO | null): void {
		if (!fboObj) return;
		const gl = this.gl;
		gl.deleteFramebuffer(fboObj.fbo);
		gl.deleteTexture(fboObj.tex);
	}

	private _freeFBOSet(fboSet: FBOSet): void {
		this._freeFBO(fboSet.bg);
		this._freeFBO(fboSet.blurA);
		this._freeFBO(fboSet.blurB);
	}

	// ────────────────────────────────────────────
	// Shader helpers
	// ────────────────────────────────────────────

	private _compile(src: string, type: number): WebGLShader | null {
		const gl = this.gl;
		const s = gl.createShader(type)!;
		gl.shaderSource(s, src);
		gl.compileShader(s);
		if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
			console.error('LiquidGlass shader compile error:', gl.getShaderInfoLog(s), src);
			return null;
		}
		return s;
	}

	private _link(vsSrc: string, fsSrc: string): WebGLProgram {
		const gl = this.gl;
		const p = gl.createProgram()!;
		gl.attachShader(p, this._compile(vsSrc, gl.VERTEX_SHADER)!);
		gl.attachShader(p, this._compile(fsSrc, gl.FRAGMENT_SHADER)!);
		gl.linkProgram(p);
		if (!gl.getProgramParameter(p, gl.LINK_STATUS)) {
			console.error('LiquidGlass program link error:', gl.getProgramInfoLog(p));
		}
		return p;
	}

	private _uloc(prog: WebGLProgram, names: string[]): UniformMap {
		const gl = this.gl;
		const u: UniformMap = {};
		for (const n of names) {
			u[n] = gl.getUniformLocation(prog, n);
		}
		return u;
	}

	private _drawQuad(prog: WebGLProgram, buf: WebGLBuffer): void {
		const gl = this.gl;
		const loc = gl.getAttribLocation(prog, 'a_pos');
		gl.bindBuffer(gl.ARRAY_BUFFER, buf);
		gl.enableVertexAttribArray(loc);
		gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
		gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
	}
}
