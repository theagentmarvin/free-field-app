/**
 * @mention helpers for the comment composer + timeline. Mentions live
 * only in the comment TEXT (`@Full Name`); the entry schema is closed
 * (rules allowlist), so nothing structured is stored — the names are
 * re-resolved against the project roster at render time.
 */

export interface MentionPerson {
  uid: string;
  name: string;
}

export interface ActiveMention {
  /** index of the "@" */
  start: number;
  query: string;
}

const ACTIVE = /(^|[\s(])@([\p{L}\p{N}._'-]*(?: [\p{L}\p{N}._'-]*)?)$/u;

/** The mention being typed at `caret`, or null. */
export function activeMention(text: string, caret: number): ActiveMention | null {
  const head = text.slice(0, caret);
  const m = ACTIVE.exec(head);
  if (!m) return null;
  const query = m[2] ?? "";
  const start = head.length - query.length - 1;
  return { start, query };
}

export function mentionCandidates(
  people: readonly MentionPerson[],
  query: string,
  limit = 6
): MentionPerson[] {
  const q = query.trim().toLowerCase();
  const scored = people
    .filter((p) => p.name.trim().length > 0)
    .map((p) => {
      const n = p.name.toLowerCase();
      const rank = q === "" ? 2 : n.startsWith(q) ? 0 : n.split(/\s+/).some((w) => w.startsWith(q)) ? 1 : n.includes(q) ? 3 : -1;
      return { p, rank };
    })
    .filter((x) => x.rank >= 0)
    .sort((a, b) => a.rank - b.rank || a.p.name.localeCompare(b.p.name));
  return scored.slice(0, limit).map((x) => x.p);
}

/** Replace the typed `@query` with the full `@Name ` and return the new caret. */
export function insertMention(
  text: string,
  caret: number,
  active: ActiveMention,
  person: MentionPerson
): { text: string; caret: number } {
  const before = text.slice(0, active.start);
  const after = text.slice(caret);
  const ins = `@${person.name} `;
  return { text: `${before}${ins}${after.replace(/^ /, "")}`, caret: before.length + ins.length };
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Longest names first so "Ana Silva" wins over "Ana". */
function mentionRegex(people: readonly MentionPerson[]): RegExp | null {
  const names = people.map((p) => p.name.trim()).filter(Boolean).sort((a, b) => b.length - a.length);
  if (names.length === 0) return null;
  return new RegExp(`(^|[\\s(])@(${names.map(escapeRe).join("|")})(?![\\p{L}\\p{N}])`, "giu");
}

export interface MentionPart {
  text: string;
  /** set when this part is a resolved @mention */
  uid?: string;
}

/** Split text into plain and mention parts for rendering. */
export function splitMentions(text: string, people: readonly MentionPerson[]): MentionPart[] {
  const re = mentionRegex(people);
  if (!re) return [{ text }];
  const byName = new Map(people.map((p) => [p.name.trim().toLowerCase(), p.uid]));
  const parts: MentionPart[] = [];
  let last = 0;
  for (const m of text.matchAll(re)) {
    const lead = m[1] ?? "";
    const idx = (m.index ?? 0) + lead.length;
    if (idx > last) parts.push({ text: text.slice(last, idx) });
    const name = m[2] ?? "";
    parts.push({ text: `@${name}`, uid: byName.get(name.toLowerCase()) });
    last = idx + 1 + name.length;
  }
  if (last < text.length) parts.push({ text: text.slice(last) });
  return parts.length > 0 ? parts : [{ text }];
}

/** Uids of the people @mentioned in `text` (deduped, in order). */
export function mentionedUids(text: string, people: readonly MentionPerson[]): string[] {
  const out: string[] = [];
  for (const p of splitMentions(text, people)) if (p.uid && !out.includes(p.uid)) out.push(p.uid);
  return out;
}
