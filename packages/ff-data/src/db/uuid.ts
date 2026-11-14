// src/core/db/uuid.ts
//
// Centralized id generation. Uses crypto.randomUUID() when available,
// otherwise falls back to a small v4-style implementation. Keeps all
// record ids in one place so swapping strategy later is easy.

export function uuid(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  // Fallback: not cryptographically strong, only used in environments
  // without crypto.randomUUID (very old browsers, certain test harnesses).
  const bytes = new Uint8Array(16);
  // The standard Crypto interface has getRandomValues; the optional
  // randomUUID() check above already narrowed the type for us, so this
  // cast is safe in any environment that has `crypto` at all.
  const c = crypto as Crypto;
  if (typeof c.getRandomValues === "function") {
    c.getRandomValues(bytes);
  } else {
    for (let i = 0; i < 16; i++) bytes[i] = Math.floor(Math.random() * 256);
  }
  bytes[6] = (bytes[6] & 0x0f) | 0x40; // version 4
  bytes[8] = (bytes[8] & 0x3f) | 0x80; // variant 1
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, "0"));
  return `${hex.slice(0, 4).join("")}-${hex.slice(4, 6).join("")}-${hex
    .slice(6, 8)
    .join("")}-${hex.slice(8, 10).join("")}-${hex.slice(10, 16).join("")}`;
}
