// packages/ff-viewer-react/perf-harness/exp.ts
//
// Experiment flags for the perf harness. Imported FIRST by main.tsx so
// the flags exist on `globalThis` before IfcViewer.tsx (or anything it
// imports) evaluates — module-scope code under experiment can read them.
//
// URL: `?exp=foo,bar,pr:0.75`  (run.mjs: `--exp=foo,bar,pr:0.75`)
//   → globalThis.__ffPerfExp = Map { "foo" => "", "bar" => "", "pr" => "0.75" }
//
// Reading a flag from viewer code while experimenting (harness only —
// in the real app the global is undefined, so the check is false):
//
//   const exp = (globalThis as { __ffPerfExp?: Map<string, string> }).__ffPerfExp;
//   if (exp?.has("foo")) { ... }            // boolean flag
//   const v = Number(exp?.get("pr") ?? NaN); // valued flag
//
// Production viewer code no longer reads this global; the built-in
// navigation speedups are overridden through the IfcViewer
// `motionSpeedups` prop instead (see motionSpeedupsFromExp in main.tsx:
// nospeedups, movebudget:<N>, movepr:<x>, nofreeze).
//
// Page-level experiments (applied by main.tsx after settle, without
// touching viewer source) live in PAGE_EXPERIMENTS in main.tsx.

export type ExpFlags = Map<string, string>;

function parse(): ExpFlags {
  const out: ExpFlags = new Map();
  const raw = new URLSearchParams(location.search).getAll("exp").join(",");
  for (const part of raw.split(",")) {
    const t = part.trim();
    if (!t) continue;
    const i = t.indexOf(":");
    if (i < 0) out.set(t, "");
    else out.set(t.slice(0, i), t.slice(i + 1));
  }
  return out;
}

export const EXP: ExpFlags = parse();
(globalThis as { __ffPerfExp?: ExpFlags }).__ffPerfExp = EXP;
