// apps/settings/src/shell/lowMemory.ts
//
// Host wiring for the viewer's low-RAM tuning (`setMemoryPressure`, wave 78).
// The viewer only ever shipped the mechanism; nothing in apps/ called it, so a
// 3 GB tablet ran with the desktop budgets. The host now asks for the
// "low" pressure level on devices that are likely to be short of memory.
//
// Deliberately conservative: only the "low" level (never "critical"), and only
// for a positive signal:
//   - `navigator.deviceMemory` <= 4 (GB, Chromium/Android; the value is
//     bucketed by the browser, so 4 means "4 or less"), or
//   - iOS / iPadOS (WebKit gives a tab far less memory than the device has;
//     `deviceMemory` does not exist there).
// Everything else is unchanged, including every browser without either signal.
//
// "low" in the viewer = invisible-tile cache scaled to 25% of the engine default
// and a coarser screen-size cull (quality -0.5). It never unloads a model.
//
// QA override (localStorage `ff.lowMemory`): "1" forces it on, "0" forces it off.

// Pure detection (no viewer imports, unit-testable). The iOS test mirrors
// `isIOSLike` in @ff/viewer's pdf/loadPdf.ts; it is repeated here so the shell
// does not import the 3D/PDF stack just to read the user agent.

export const LOW_MEMORY_DEVICE_GB = 4;
export const LOW_MEMORY_OVERRIDE_KEY = "ff.lowMemory";

export interface NavLike {
  deviceMemory?: number;
  userAgent?: string;
  platform?: string;
  maxTouchPoints?: number;
}

export function shouldUseLowMemoryTuning(
  nav: NavLike | undefined = typeof navigator !== "undefined" ? (navigator as NavLike) : undefined,
  override: string | null = readOverride(),
): boolean {
  if (override === "1") return true;
  if (override === "0") return false;
  if (!nav) return false;
  if (typeof nav.deviceMemory === "number" && nav.deviceMemory > 0 && nav.deviceMemory <= LOW_MEMORY_DEVICE_GB) {
    return true;
  }
  return isIOSLike(nav);
}

function readOverride(): string | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage.getItem(LOW_MEMORY_OVERRIDE_KEY);
  } catch {
    return null;
  }
}


function isIOSLike(n: NavLike): boolean {
  if (/iPad|iPhone|iPod/.test(n.userAgent ?? "")) return true;
  // iPadOS 13+ reports itself as a Mac with touch.
  return n.platform === "MacIntel" && (n.maxTouchPoints ?? 0) > 1;
}
