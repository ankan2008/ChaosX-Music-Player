/**
 * The boot screen, from the inside.
 *
 * The splash itself is static markup in `index.html` — see the comment there for why
 * it has to be painted before this bundle exists at all. This is the only code
 * allowed to take it away, and it is deliberately not React: the node is outside the
 * root, it must survive a render that throws, and the whole exchange is two DOM
 * writes.
 */
const FADE_MS = 320;

function node(): HTMLElement | null {
  return document.getElementById('boot-splash');
}

/**
 * What the app is doing, when it is doing it for long enough to be worth naming.
 *
 * A first run reads every file in the library before it can show one, and the wait
 * used to be silent — which on a two-core laptop reads as a hang rather than as work.
 * An empty string puts the line back the way it was.
 */
export function setBootStatus(text: string): void {
  const splash = node();
  if (!splash) return;
  const line = splash.querySelector('.bs-status');
  if (line) line.textContent = text;
}

/**
 * Dissolve onto the interface.
 *
 * Faded first and removed after, because the alternative is a hard cut from a
 * wallpaper to the app standing in front of the same wallpaper, which reads as a
 * second load. The node is taken out of the document at the end rather than left at
 * zero opacity: it is `position: fixed` over everything, and an invisible layer that
 * still eats pointer events is a UI that has stopped responding with no explanation.
 *
 * Safe to call twice, and from anywhere — a page that has already dismissed its
 * splash has nothing left to do.
 */
export function dismissBootSplash(): void {
  const splash = node();
  if (!splash || splash.dataset.dismissed) return;
  splash.dataset.dismissed = '1';
  splash.classList.add('bs-leaving');
  window.setTimeout(() => splash.remove(), FADE_MS);
}
