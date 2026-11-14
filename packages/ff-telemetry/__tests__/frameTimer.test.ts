import { describe, it, expect, vi } from "vitest";

import {
  startFrameTimer,
  getFrameStats,
  type FrameTimerOptions,
} from "../src/frameTimer";

/** A minimal fake requestAnimationFrame harness: `raf` stores the
 *  pending callback; `step()` synchronously runs it once (and the
 *  timer immediately re-registers via `raf` inside the tick). */
function makeFakeRaf() {
  let pending: FrameRequestCallback | null = null;
  const raf = (cb: FrameRequestCallback): number => {
    pending = cb;
    return 1;
  };
  const cancel = (): void => {
    pending = null;
  };
  const step = (): void => {
    const cb = pending;
    pending = null;
    if (cb) cb(0);
  };
  return { raf, cancel, step };
}

/** A mutable injected clock so each frame's delta is exact. */
function makeClock(start = 0) {
  let t = start;
  return { now: () => t, set: (x: number) => { t = x; } };
}

function timerOpts(
  raf: ReturnType<typeof makeFakeRaf>,
  clock: ReturnType<typeof makeClock>,
  extra: Partial<FrameTimerOptions> = {},
): FrameTimerOptions {
  return {
    requestAnimationFrame: raf.raf,
    cancelAnimationFrame: raf.cancel,
    now: clock.now,
    ...extra,
  };
}

function wallClock(): () => number {
  return typeof performance !== "undefined" &&
    typeof performance.now === "function"
    ? () => performance.now()
    : () => Date.now();
}

describe("frameTimer EMA (α = 0.1)", () => {
  it("folds frame deltas into an EMA, initializing from the first sample", () => {
    const raf = makeFakeRaf();
    const clock = makeClock();
    const stop = startFrameTimer(undefined, timerOpts(raf, clock));

    clock.set(0);
    raf.step(); // baseline — establishes lastNow, no sample
    expect(getFrameStats().sampleCount).toBe(0);

    clock.set(100);
    raf.step(); // delta 100 → ema initialized to 100
    expect(getFrameStats().frameEmaMs).toBeCloseTo(100, 10);

    clock.set(200);
    raf.step(); // delta 100 → 0.1*100 + 0.9*100 = 100
    expect(getFrameStats().frameEmaMs).toBeCloseTo(100, 10);

    clock.set(400);
    raf.step(); // delta 200 → 0.1*200 + 0.9*100 = 110
    expect(getFrameStats().frameEmaMs).toBeCloseTo(110, 10);

    clock.set(600);
    raf.step(); // delta 200 → 0.1*200 + 0.9*110 = 119
    expect(getFrameStats().frameEmaMs).toBeCloseTo(119, 10);

    stop();
  });

  it("honors a custom alpha", () => {
    const raf = makeFakeRaf();
    const clock = makeClock();
    const stop = startFrameTimer(undefined, timerOpts(raf, clock, { alpha: 0.5 }));

    clock.set(0);
    raf.step();
    clock.set(100);
    raf.step(); // ema = 100
    clock.set(300);
    raf.step(); // delta 200 → 0.5*200 + 0.5*100 = 150
    expect(getFrameStats().frameEmaMs).toBeCloseTo(150, 10);
    stop();
  });
});

describe("frameTimer percentile + max accumulators", () => {
  it("computes p50/p95/p99 + frameMax over the rolling window (nearest-rank)", () => {
    const raf = makeFakeRaf();
    const clock = makeClock();
    const stop = startFrameTimer(undefined, timerOpts(raf, clock, { maxSamples: 6 }));

    // deltas: 10, 20, 30, 40, 50
    clock.set(0); raf.step();   // baseline
    clock.set(10); raf.step();  // 10
    clock.set(30); raf.step();  // 20
    clock.set(60); raf.step();  // 30
    clock.set(100); raf.step(); // 40
    clock.set(150); raf.step(); // 50

    const s = getFrameStats();
    expect(s.sampleCount).toBe(5);
    expect(s.frameMaxMs).toBe(50);
    expect(s.p50).toBe(30);
    expect(s.p95).toBe(50);
    expect(s.p99).toBe(50);
    stop();
  });

  it("wraps the rolling window, dropping the oldest delta", () => {
    const raf = makeFakeRaf();
    const clock = makeClock();
    const stop = startFrameTimer(undefined, timerOpts(raf, clock, { maxSamples: 3 }));

    // deltas: 10, 20, 30, 40 → window keeps [20, 30, 40]
    clock.set(0); raf.step();
    clock.set(10); raf.step();
    clock.set(30); raf.step();
    clock.set(60); raf.step();
    clock.set(100); raf.step();

    const s = getFrameStats();
    expect(s.sampleCount).toBe(3);
    expect(s.frameMaxMs).toBe(40);
    expect(s.p50).toBe(30); // sorted [20,30,40], p50 → index 1
    stop();
  });

  it("ignores a backwards clock (delta clamped to 0)", () => {
    const raf = makeFakeRaf();
    const clock = makeClock();
    const stop = startFrameTimer(undefined, timerOpts(raf, clock));

    clock.set(100);
    raf.step();
    clock.set(200);
    raf.step(); // delta 100
    clock.set(150);
    raf.step(); // backwards → clamped 0
    const s = getFrameStats();
    expect(s.frameMaxMs).toBe(100);
    expect(s.frameEmaMs).toBeCloseTo(90, 10); // 0.1*0 + 0.9*100
    stop();
  });
});

describe("frameTimer stop / callback / safety", () => {
  it("stop() halts further ticks", () => {
    const raf = makeFakeRaf();
    const clock = makeClock();
    const stop = startFrameTimer(undefined, timerOpts(raf, clock));

    clock.set(0); raf.step();
    clock.set(100); raf.step();
    expect(getFrameStats().sampleCount).toBe(1);
    stop();
    clock.set(200); raf.step(); // cancelled — no further tick
    expect(getFrameStats().sampleCount).toBe(1);
  });

  it("invokes the per-frame callback on every tick", () => {
    const raf = makeFakeRaf();
    const clock = makeClock();
    const cb = vi.fn();
    const stop = startFrameTimer(cb, timerOpts(raf, clock));

    clock.set(0); raf.step();
    clock.set(100); raf.step();
    clock.set(200); raf.step();
    expect(cb).toHaveBeenCalledTimes(3);
    stop();
  });

  it("never throws when the callback throws (survivability)", () => {
    const raf = makeFakeRaf();
    const clock = makeClock();
    const stop = startFrameTimer(
      () => {
        throw new Error("callback exploded");
      },
      timerOpts(raf, clock),
    );
    expect(() => {
      clock.set(0); raf.step();
      clock.set(100); raf.step();
    }).not.toThrow();
    expect(getFrameStats().sampleCount).toBe(1);
    stop();
  });

  it("idles safely when requestAnimationFrame schedules nothing", () => {
    const clock = makeClock();
    // Inject a no-op scheduler (frameless context): the timer must not
    // throw and must return empty stats.
    const stop = startFrameTimer(undefined, {
      now: clock.now,
      requestAnimationFrame: () => 0,
      cancelAnimationFrame: () => {},
    });
    expect(() => getFrameStats()).not.toThrow();
    expect(getFrameStats().sampleCount).toBe(0);
    stop();
  });
});

describe("frameTimer rAF-added-cost benchmark", () => {
  it("adds < 0.15 ms/frame of work in a jsdom + fake-RAF harness", () => {
    const raf = makeFakeRaf();
    let t = 0;
    const now = () => t;
    const nowWall = wallClock();
    const cb = vi.fn();
    const stop = startFrameTimer(cb, {
      requestAnimationFrame: raf.raf,
      cancelAnimationFrame: raf.cancel,
      now,
    });

    // Warmup (JIT, first-run paths) that is not measured.
    for (let i = 0; i < 1000; i++) {
      t += 16.7;
      raf.step();
    }

    const frames = 20_000;
    const start = nowWall();
    for (let i = 0; i < frames; i++) {
      t += 16.7;
      raf.step();
    }
    const elapsed = nowWall() - start;
    const msPerFrame = elapsed / frames;
    // eslint-disable-next-line no-console
    console.log(
      `[bench] ff-telemetry rAF added cost: ${msPerFrame.toFixed(6)} ms/frame`,
    );

    expect(msPerFrame).toBeLessThan(0.15);
    stop();
  });
});