/**
 * One physical media button can reach the app twice: Windows hands it to
 * whichever app owns the SMTC session (which `navigator.mediaSession` is), and
 * the main process also holds a `globalShortcut` for it as a fallback while the
 * app is in the background. Without a tie-break both fire, and play+pause in
 * the same beat reads as a dead key.
 *
 * Whichever path claims the press first wins; the other drops it.
 */
let lastClaim = 0;

export function claimMediaKey(): boolean {
  const now = Date.now();
  if (now - lastClaim < 300) return false;
  lastClaim = now;
  return true;
}
