// Flag-gated stage timings for the compare pipeline.
// Enable with `localStorage["ff-compare-debug"] = "1"`; output goes to console.debug.

export function debugEnabled(): boolean {
  try {
    return typeof localStorage !== "undefined" && localStorage.getItem("ff-compare-debug") === "1";
  } catch {
    return false;
  }
}

export interface StageTimer {
  /** Record the time since the previous mark under `name`. */
  mark(name: string): void;
  /** Add a measured duration (for work that overlaps in time, e.g. both sides rendering). */
  add(name: string, ms: number): void;
  /** Log the table (no-op when the flag is off). */
  end(extra?: Record<string, unknown>): void;
}

const NOOP: StageTimer = { mark() {}, add() {}, end() {} };

export function createTimer(label: string): StageTimer {
  if (!debugEnabled()) return NOOP;
  // eslint-disable-next-line no-console
  console.debug(`[compare] start ${label}`);
  const t0 = performance.now();
  let last = t0;
  const stages: Record<string, number> = {};
  return {
    mark(name) {
      const now = performance.now();
      stages[name] = Math.round((stages[name] ?? 0) + (now - last));
      last = now;
    },
    add(name, ms) {
      stages[name] = Math.round((stages[name] ?? 0) + ms);
    },
    end(extra) {
      const total = Math.round(performance.now() - t0);
      // eslint-disable-next-line no-console
      console.debug(`[compare] ${label}`, JSON.stringify({ total, ...stages, ...extra }));
    },
  };
}

/** performance.now() of the last finished run, so the viewer can log time-to-paint. */
let lastDoneAt = 0;
export function noteRunDone(): void {
  lastDoneAt = performance.now();
}
export function logPaint(what: string): void {
  if (!debugEnabled() || lastDoneAt === 0) return;
  // eslint-disable-next-line no-console
  console.debug(`[compare] paint ${what}`, JSON.stringify({ sinceDone: Math.round(performance.now() - lastDoneAt) }));
  lastDoneAt = 0;
}

let runCounter = 0;
export function nextRunId(): number {
  return ++runCounter;
}
