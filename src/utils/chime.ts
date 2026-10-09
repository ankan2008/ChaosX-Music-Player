/**
 * The pomodoro chime — a bell, not a beep.
 *
 * The user asked for something "peaceful", and the two things that are not
 * peaceful at the end of a focus block are the system ding and a square wave.
 * This is a struck sine with a fifth above it, decaying, struck four times over
 * five seconds: loud enough to hear from another room, short enough not to
 * become the thing you remember about the app.
 *
 * It runs on its own `AudioContext` rather than the player's graph on purpose.
 * The DSP chain has a limiter, a compressor and a speed control on it, all of
 * which are wrong for an alarm, and the timer has to be able to ring while
 * nothing is playing.
 */

let ctx: AudioContext | null = null;

const FUNDAMENTAL = 523.25; // C5
const FIFTH = 784.0; // G5

export function playChime(seconds = 5, level = 0.18): void {
  try {
    const AC: typeof AudioContext | undefined =
      window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AC) return;
    ctx ??= new AC();
    if (ctx.state === 'suspended') void ctx.resume();

    const now = ctx.currentTime;
    const master = ctx.createGain();
    master.gain.value = Math.max(0.02, Math.min(0.4, level));
    master.connect(ctx.destination);

    const gap = 1.25;
    const strikes = Math.max(1, Math.floor(seconds / gap));
    for (let i = 0; i < strikes; i++) {
      const t = now + i * gap;
      [[FUNDAMENTAL, 0.55], [FIFTH, 0.2]].forEach(([freq, gain]) => {
        const osc = ctx!.createOscillator();
        const env = ctx!.createGain();
        osc.type = 'sine';
        osc.frequency.value = freq;
        env.gain.setValueAtTime(0, t);
        env.gain.linearRampToValueAtTime(gain, t + 0.015);
        env.gain.exponentialRampToValueAtTime(0.0001, t + 1.5);
        osc.connect(env);
        env.connect(master);
        osc.start(t);
        osc.stop(t + 1.6);
      });
    }
    window.setTimeout(() => master.disconnect(), (strikes * gap + 2) * 1000);
  } catch {
    // No output device, or the context could not be created. A timer that
    // cannot ring should still keep counting.
  }
}
