/**
 * Full-screen overlays that live deep in a screen (the document viewer) register
 * here, so the Android Back button closes them before App's own back handling.
 * The most recently opened overlay closes first.
 */
const handlers: (() => void)[] = [];

/** Registers `close`; call the returned function when the overlay closes by itself. */
export function pushBackHandler(close: () => void): () => void {
  handlers.push(close);
  return () => {
    const index = handlers.lastIndexOf(close);
    if (index >= 0) handlers.splice(index, 1);
  };
}

/** Closes the top overlay. False when none is open. */
export function closeTopOverlay(): boolean {
  const close = handlers.pop();
  if (!close) return false;
  close();
  return true;
}
