import React, { useCallback, useEffect, useRef, useState } from 'react';
import { getEngine } from '../../audio/engine';
import { usePlayerStore } from '../../stores/playerStore';
import { formatTime } from '../../utils/formatTime';
import { DEFAULT_ACCENT, extractAccentColor } from '../../utils/accentColor';

interface WaveformProgressProps {
  peaks: number[];
  duration: number;
  /**
   * Only the starting position, for the frame before the render loop has a
   * reading. The playhead itself comes from `getEngine().getRenderPosition()`
   * inside the draw loop, so this surface takes no part in React's position
   * updates and a parent does not have to re-render to move the thumb.
   */
  position?: number;
  trackId?: string;
  className?: string;
  /**
   * Which way the track runs. `vertical` is the pill's lane, and time travels
   * **upward** — the thumb leaves the bottom edge and climbs to the top, which
   * is how a volume-fader-shaped control reads when it is stood on end. It is
   * drawn by transposing the canvas axes rather than rotating a horizontal bar:
   * a rotated bar cannot be sized to its lane in CSS and would hit-test the
   * wrong edge.
   */
  orientation?: 'horizontal' | 'vertical';
}

const TAU = Math.PI * 2;
/**
 * One wave riding one line: a fixed pixel wavelength, so the ripple keeps
 * its scale as the played stretch grows, with an envelope that tapers to
 * flat at both ends — the line leaves the start and arrives at the thumb
 * without a step.
 */
const WAVE_LENGTH_PX = 132;
/** Phase drift in radians per second while playing. */
const ANIMATION_SPEED = 1.9;
/** Coarsest step at which the clock readout is dragged along. */
const PREVIEW_STEP = 0.2;

/**
 * A single travelling sine over a dim straight line. The earlier design
 * layered two offset ripples; this keeps one, and the depth comes from a
 * wide low-alpha pass of the same path rather than a second wave.
 *
 * Nothing in the frame loop reads React state: the playhead comes straight
 * off the deck, the pointer comes off refs, and the canvas size comes off a
 * ResizeObserver, so a drag never costs a re-render. While the pointer is
 * down the engine holds the audio still and only the playhead moves — seeking
 * on every pointer event is what used to make the track crackle.
 */
const WaveformProgress: React.FC<WaveformProgressProps> = ({
  duration,
  position = 0,
  trackId,
  className = '',
  orientation = 'horizontal',
}) => {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const thumbRef = useRef<HTMLSpanElement | null>(null);
  const [accent, setAccent] = useState(DEFAULT_ACCENT);
  const [dragging, setDragging] = useState(false);

  const viewRef = useRef({
    duration,
    position,
    hoverRatio: null as number | null,
    dragging: false,
    /** Where the cursor is holding the playhead, in seconds. */
    scrubTo: null as number | null,
    /** Last scrub time handed to the clock readout. */
    previewed: 0,
    accent,
  });
  viewRef.current.duration = duration;
  viewRef.current.accent = accent;
  viewRef.current.position = position;

  const track = usePlayerStore((s) =>
    trackId
      ? s.library.find((t) => t.id === trackId) ?? s.queue.find((t) => t.id === trackId) ?? null
      : null,
  );

  useEffect(() => {
    let alive = true;
    const art = track?.albumArt;
    if (!art) {
      setAccent(DEFAULT_ACCENT);
      return;
    }
    void extractAccentColor(art).then((c) => {
      if (alive) setAccent(c);
    });
    return () => {
      alive = false;
    };
  }, [track?.id, track?.albumArt]);

  useEffect(() => {
    let raf = 0;
    let lastTs = 0;
    /** When the canvas was last actually painted, for the potato-mode throttle. */
    let lastDraw = 0;
    let phase = 0;
    let width = 0;
    let height = 0;

    const canvas = canvasRef.current;
    if (!canvas) return;
    const measure = () => {
      width = canvas.clientWidth;
      height = canvas.clientHeight;
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(canvas);

    const traceWave = (
      ctx: CanvasRenderingContext2D,
      playedX: number,
      midY: number,
      amp: number,
      wavePhase: number,
    ) => {
      if (playedX <= 1) return false;
      const steps = Math.max(24, Math.min(360, Math.round(playedX / 2)));
      ctx.beginPath();
      for (let i = 0; i <= steps; i++) {
        const t = i / steps;
        const x = t * playedX;
        // Taper to flat at both ends, so the ripple leaves the start and
        // arrives at the thumb as a straight line rather than a step.
        const envelope = Math.pow(Math.sin(Math.PI * t), 0.62);
        const y = midY + Math.sin((x / WAVE_LENGTH_PX) * TAU + wavePhase) * amp * envelope;
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      return true;
    };

    const render = (ts: number) => {
      const gap = lastTs ? (ts - lastTs) / 1000 : 0;
      lastTs = ts;
      const st = usePlayerStore.getState();
      /*
       * The wave's clock is wound up here, above the throttle below, so skipping a
       * redraw cannot make the ripple crawl — the phase is paid for in real seconds
       * whether the frame is drawn or not.
       */
      if (st.isPlaying || viewRef.current.dragging) phase += Math.min(0.25, gap) * ANIMATION_SPEED;
      lastDraw = ts;
      const ctx = canvas.getContext('2d');
      if (!ctx || width <= 0 || height <= 0) {
        raf = requestAnimationFrame(render);
        return;
      }

      const view = viewRef.current;
      const { duration: dur, hoverRatio: hover, dragging: drag, accent: col } = view;

      const vertical = orientation === 'vertical';
      const dpr = window.devicePixelRatio || 1;
      const pxW = Math.round(width * dpr);
      const pxH = Math.round(height * dpr);
      if (canvas.width !== pxW || canvas.height !== pxH) {
        canvas.width = pxW;
        canvas.height = pxH;
      }

      /*
       * Everything below is written as "along" (the direction time travels) and
       * "across" (the direction the wave oscillates). Vertical is then just a
       * transpose of the canvas axes, which keeps one body of drawing maths
       * instead of two that have to stay in step.
       */
      const along = vertical ? height : width;
      const across = vertical ? width : height;

      const live = getEngine().getRenderPosition();
      const pos = view.scrubTo ?? (live > 0 ? live : view.position);

      // The deck is held still while dragging, so the clock readout has to be
      // dragged by hand — a few steps a second, not one per pointer event.
      if (
        drag &&
        view.scrubTo !== null &&
        Math.abs(view.scrubTo - view.previewed) >= PREVIEW_STEP
      ) {
        view.previewed = view.scrubTo;
        getEngine().previewScrub(view.scrubTo);
      }

      const playedRatio = dur > 0 ? Math.min(1, Math.max(0, pos / dur)) : 0;
      const playedX = playedRatio * along;

      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, pxW, pxH);
      /*
       * Horizontal maps user-x straight onto screen-x. Vertical maps user-x
       * *upwards*, so time starts at the lane's bottom edge — a negative
       * y-scale alone would draw the whole wave off-canvas, hence the translate
       * to the device height.
       */
      ctx.setTransform(
        vertical ? 0 : dpr,
        vertical ? -dpr : 0,
        vertical ? dpr : 0,
        vertical ? 0 : dpr,
        0,
        vertical ? pxH : 0,
      );

      const mid = across / 2;
      const amp = Math.max(3, across * 0.16);

      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';

      // Unplayed remainder only: the stretch the wave already covers must not
      // also carry the straight line, or the two read as separate controls.
      ctx.strokeStyle = 'rgba(255, 255, 255, 0.28)';
      ctx.lineWidth = Math.max(3, across * 0.075);
      ctx.beginPath();
      ctx.moveTo(playedX, mid);
      ctx.lineTo(along, mid);
      ctx.stroke();

      // Played stretch: one wave, drawn twice — a wide soft pass for depth
      // under a crisp core, which is what reads as glass rather than a line.
      ctx.strokeStyle = col;
      if (traceWave(ctx, playedX, mid, amp, phase)) {
        ctx.globalAlpha = 0.2;
        ctx.lineWidth = Math.max(7, across * 0.2);
        ctx.stroke();

        ctx.globalAlpha = 1;
        ctx.lineWidth = Math.max(3, across * 0.085);
        ctx.stroke();
      }

      // Thumb: a real DOM pill rides the same frame loop as the wave, so its
      // backdrop-filter refracts whatever it has travelled over.
      const thumb = thumbRef.current;
      if (thumb) {
        const at = Math.max(0, Math.min(along, playedX));
        // Negative because the vertical thumb is anchored to the lane's bottom.
        thumb.style.transform = vertical
          ? `translate(-50%, ${-at}px)`
          : `translate(${at}px, -50%)`;
        thumb.style.visibility = dur > 0 ? 'visible' : 'hidden';
      }

      // Hover time bubble. Drawn in screen space, because text transposed with
      // the canvas axes would read sideways down the strip.
      if (hover !== null && dur > 0 && across > 26) {
        const label = formatTime(hover * dur);
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.scale(dpr, dpr);
        ctx.font = '600 10px Cocon, GS Round, system-ui, sans-serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        const tw = ctx.measureText(label).width;
        const at = hover * along;
        // `at` counts up from the lane's start; screen y counts down from the
        // top, so the vertical bubble has to be flipped back.
        const bx = vertical ? across / 2 : Math.max(18, Math.min(along - 18, at));
        const by = vertical
          ? Math.max(10, Math.min(along - 10, along - at))
          : 8.5;
        ctx.fillStyle = 'rgba(14, 12, 16, 0.86)';
        ctx.beginPath();
        ctx.roundRect(bx - tw / 2 - 6, by - 7, tw + 12, 14, 7);
        ctx.fill();
        ctx.fillStyle = 'rgba(255, 255, 255, 0.92)';
        ctx.fillText(label, bx, by);
      }

      raf = requestAnimationFrame(render);
    };

    raf = requestAnimationFrame(render);
    return () => {
      cancelAnimationFrame(raf);
      observer.disconnect();
    };
  }, [orientation]);

  /**
   * Where along the track a pointer sits. Reads the axis the wave actually runs
   * down, and for the vertical lane measures up from its bottom edge, so time
   * increases in the direction the playhead travels.
   */
  const ratioFromPointer = useCallback(
    (clientX: number, clientY: number): number => {
      const canvas = canvasRef.current;
      if (!canvas) return 0;
      const rect = canvas.getBoundingClientRect();
      const span = orientation === 'vertical' ? rect.height : rect.width;
      if (span === 0) return 0;
      const at =
        orientation === 'vertical'
          ? rect.bottom - clientY
          : clientX - rect.left;
      return Math.max(0, Math.min(1, at / span));
    },
    [orientation],
  );

  /** Moves the playhead only; the audio waits for the release. */
  const dragTo = useCallback(
    (clientX: number, clientY: number) => {
      const view = viewRef.current;
      if (!view.duration) return;
      view.scrubTo = ratioFromPointer(clientX, clientY) * view.duration;
    },
    [ratioFromPointer],
  );

  const onPointerMove = useCallback(
    (event: { clientX: number; clientY: number }) => {
      viewRef.current.hoverRatio = ratioFromPointer(event.clientX, event.clientY);
      if (viewRef.current.dragging) dragTo(event.clientX, event.clientY);
    },
    [dragTo, ratioFromPointer],
  );

  return (
    <div
      className={`wave-slider ${orientation === 'vertical' ? 'is-vertical' : ''} ${className}`}
      data-dragging={dragging ? '' : undefined}
      onMouseLeave={() => {
        if (!viewRef.current.dragging) viewRef.current.hoverRatio = null;
      }}
    >
      <canvas
        ref={canvasRef}
        className="wave-canvas"
        onMouseMove={onPointerMove}
        onMouseDown={(event) => {
          event.preventDefault();
          const view = viewRef.current;
          view.dragging = true;
          view.hoverRatio = ratioFromPointer(event.clientX, event.clientY);
          view.previewed = getEngine().getRenderPosition();
          setDragging(true);
          getEngine().beginScrub();
          dragTo(event.clientX, event.clientY);
          const onMove = (ev: MouseEvent) => onPointerMove(ev);
          const onUp = () => {
            window.removeEventListener('mousemove', onMove);
            window.removeEventListener('mouseup', onUp);
            const target = view.scrubTo;
            view.dragging = false;
            view.scrubTo = null;
            setDragging(false);
            if (target !== null) getEngine().endScrub(target);
          };
          window.addEventListener('mousemove', onMove);
          window.addEventListener('mouseup', onUp);
        }}
      />
      <span className="wave-thumb" ref={thumbRef} aria-hidden />
    </div>
  );
};

export default WaveformProgress;
