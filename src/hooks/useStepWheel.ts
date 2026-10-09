import { useEffect, useRef, type RefObject } from 'react';

/**
 * One wheel notch moves the value by exactly one step — no more, no less.
 *
 * `deltaY` is not a notch count. A mouse click on Windows reports 100, a
 * trackpad flick reports a stream of 1–20s, and some devices report
 * `deltaMode: 1` where the number means *lines* rather than pixels. Dividing
 * by a constant therefore either swallows trackpad input or turns one fast
 * flick into a jump of thirty. Accumulating the delta and spending it a whole
 * notch at a time is what makes a slow click and a fast flick land on the same
 * number of steps, which is the behaviour these controls were specified with.
 *
 * `passive: false` is required to cancel the scroll: the pill sits above the
 * song list, and without it nudging the volume also pages the library.
 */
const NOTCH = 100;
/** A pathological single event (a 500px fling) must not eat the whole control. */
const MAX_STEPS = 8;

export function useStepWheel(
  ref: RefObject<HTMLElement>,
  onStep: (direction: 1 | -1) => void,
): void {
  const stepRef = useRef(onStep);
  stepRef.current = onStep;

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    let carried = 0;

    const onWheel = (event: WheelEvent) => {
      const pixels = event.deltaMode === 1 ? event.deltaY * 33 : event.deltaY;
      if (!pixels) return;
      event.preventDefault();
      carried += pixels;

      let spent = 0;
      while (Math.abs(carried) >= NOTCH && spent < MAX_STEPS) {
        // Scroll up increases, scroll down decreases, like every native slider.
        const notch = carried < 0 ? -NOTCH : NOTCH;
        carried -= notch;
        spent += 1;
        stepRef.current(notch < 0 ? 1 : -1);
      }
      if (spent === MAX_STEPS) carried = 0;
    };

    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [ref]);
}
