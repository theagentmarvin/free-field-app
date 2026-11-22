// Let the browser paint between heavy stages (spinner keeps animating).

export function yieldFrame(): Promise<void> {
  return new Promise<void>((resolve) => {
    let done = false;
    const fin = () => {
      if (done) return;
      done = true;
      resolve();
    };
    // rAF is paused in background tabs; the timeout guarantees progress.
    if (typeof requestAnimationFrame === "function") requestAnimationFrame(() => fin());
    setTimeout(fin, 50);
  });
}
