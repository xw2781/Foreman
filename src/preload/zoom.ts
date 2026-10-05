/** App-wide page zoom, including chats, terminals, and dialogs. */
export function installAppZoom(target: Window, frame: { getZoomFactor(): number; setZoomFactor(factor: number): void }) {
  const apply = (factor: number) => {
    const next = Math.min(2, Math.max(0.5, Math.round(factor * 100) / 100));
    frame.setZoomFactor(next);
    try { target.localStorage.setItem('appZoomFactor', String(next)); } catch { /* Storage unavailable. */ }
  };
  try {
    const saved = Number(target.localStorage.getItem('appZoomFactor'));
    if (Number.isFinite(saved) && saved >= 0.5 && saved <= 2) frame.setZoomFactor(saved);
  } catch { /* Storage unavailable. */ }
  const wheel = (event: WheelEvent) => {
    if (!event.ctrlKey || event.deltaY === 0) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    apply(frame.getZoomFactor() + (event.deltaY < 0 ? 0.1 : -0.1));
  };
  const key = (event: KeyboardEvent) => {
    if (!event.ctrlKey || event.altKey || event.shiftKey || event.key !== '0') return;
    event.preventDefault();
    event.stopImmediatePropagation();
    apply(1);
  };
  target.addEventListener('wheel', wheel, { capture: true, passive: false });
  target.addEventListener('keydown', key, true);
  return () => {
    target.removeEventListener('wheel', wheel, true);
    target.removeEventListener('keydown', key, true);
  };
}
