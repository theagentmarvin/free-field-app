import { ProjectDatabase } from "@ff/data/db/database";
import { createSyncEngine, type SyncEngine } from "../src";
import type {
  BlobTransport,
  RemoteChange,
  RemoteDocs,
  RemoteSubscription,
  SyncCollectionName,
} from "../src/types";

let dbCounter = 0;
export function freshDb(): ProjectDatabase {
  return new ProjectDatabase(`sync-test-${Date.now()}-${dbCounter++}`);
}

interface StoredDoc {
  data: Record<string, unknown>;
  updatedAtMs: number;
  deleted: boolean;
}

/** In-memory Firestore stand-in: one server clock, per-collection listeners. */
export class FakeServer {
  clock = 1_000_000;
  docs = new Map<string, StoredDoc>();
  listeners = new Set<{ key: string; afterMs: number | null; h: RemoteSubscription }>();
  writes: Array<{ op: string; key: string }> = [];
  failNextWrites = 0;

  private key(pid: string, c: string) {
    return `${pid}/${c}`;
  }

  tick(): number {
    this.clock += 10;
    return this.clock;
  }

  /** Server-side write used by "another device" in tests. */
  put(pid: string, c: SyncCollectionName, id: string, data: Record<string, unknown>, deleted = false): void {
    const updatedAtMs = this.tick();
    const doc = { data: { ...data, id }, updatedAtMs, deleted };
    this.docs.set(`${this.key(pid, c)}/${id}`, doc);
    this.deliver(this.key(pid, c), [{ id, updatedAtMs, deleted, data: doc.data }]);
  }

  private deliver(key: string, changes: RemoteChange[]): void {
    for (const l of this.listeners) {
      if (l.key !== key) continue;
      const mine = changes.filter((c) => l.afterMs == null || c.updatedAtMs > l.afterMs);
      if (mine.length) queueMicrotask(() => l.h.onChanges(mine));
    }
  }

  remote(opts: { online?: () => boolean } = {}): RemoteDocs {
    const self = this;
    const guard = () => {
      if (opts.online && !opts.online()) {
        const e = new Error("offline") as Error & { code: string };
        e.code = "unavailable";
        throw e;
      }
      if (self.failNextWrites > 0) {
        self.failNextWrites -= 1;
        const e = new Error("denied") as Error & { code: string };
        e.code = "permission-denied";
        throw e;
      }
    };
    return {
      subscribe(pid, c, afterMs, h) {
        const key = self.key(pid, c);
        const entry = { key, afterMs, h };
        self.listeners.add(entry);
        const initial: RemoteChange[] = [];
        for (const [k, d] of self.docs) {
          if (!k.startsWith(key + "/")) continue;
          if (afterMs != null && d.updatedAtMs <= afterMs) continue;
          initial.push({ id: k.slice(key.length + 1), updatedAtMs: d.updatedAtMs, deleted: d.deleted, data: d.data });
        }
        if (initial.length) queueMicrotask(() => h.onChanges(initial));
        return () => self.listeners.delete(entry);
      },
      async get(pid, c, id) {
        const d = self.docs.get(`${self.key(pid, c)}/${id}`);
        return d ? { deleted: d.deleted, data: d.data } : null;
      },
      async listWhere(pid, c, field, value) {
        const key = self.key(pid, c) + "/";
        return [...self.docs].filter(([k, d]) => k.startsWith(key) && d.data[field] === value).map(([, d]) => d.data);
      },
      async upsert(pid, c, id, data) {
        guard();
        self.writes.push({ op: "upsert", key: `${c}/${id}` });
        self.put(pid, c, id, data);
      },
      async tombstone(pid, c, id) {
        guard();
        const d = self.docs.get(`${self.key(pid, c)}/${id}`);
        if (!d || d.deleted) return;
        self.writes.push({ op: "tombstone", key: `${c}/${id}` });
        self.put(pid, c, id, d.data, true);
      },
    };
  }
}

export class FakeBucket {
  objects = new Map<string, { blob: Blob; sha256: string }>();
  uploads: string[] = [];
  downloads: string[] = [];
  corrupt = new Set<string>();
  transport(opts: { withUrls?: boolean } = {}): BlobTransport {
    const self = this;
    return {
      async head(path) {
        const o = self.objects.get(path);
        return o ? { sizeBytes: o.blob.size, sha256: o.sha256 } : null;
      },
      async upload(path, blob, opts) {
        if (self.objects.has(path)) throw Object.assign(new Error("overwrite denied"), { code: "storage/unauthorized" });
        self.uploads.push(path);
        opts.onProgress?.(blob.size, blob.size);
        self.objects.set(path, { blob, sha256: opts.sha256 });
      },
      async download(path) {
        const o = self.objects.get(path);
        if (!o) throw Object.assign(new Error("nf"), { code: "storage/object-not-found" });
        self.downloads.push(path);
        return self.corrupt.has(path) ? new Blob([new Uint8Array(o.blob.size).fill(9)]) : o.blob;
      },
      ...(opts.withUrls
        ? { getDownloadUrl: async (path: string) => `fake://bucket/${path}` }
        : {}),
    };
  }
}

export function makeEngine(
  server: FakeServer,
  bucket: FakeBucket,
  opts: { db?: ProjectDatabase; uid?: string; online?: { value: boolean } } = {},
): { engine: SyncEngine; db: ProjectDatabase; online: { value: boolean } } {
  const db = opts.db ?? freshDb();
  const online = opts.online ?? { value: true };
  const engine = createSyncEngine({
    db,
    remote: server.remote({ online: () => online.value }),
    transport: bucket.transport(),
    uid: opts.uid ?? "admin-1",
    isOnline: () => online.value,
  });
  return { engine, db, online };
}

export async function waitFor(fn: () => Promise<boolean> | boolean, ms = 5000): Promise<void> {
  const t0 = Date.now();
  for (;;) {
    if (await fn()) return;
    if (Date.now() - t0 > ms) throw new Error("waitFor timed out");
    await new Promise((r) => setTimeout(r, 15));
  }
}

export const bytes = (n: number, fill = 1): Blob => new Blob([new Uint8Array(n).fill(fill)]);

export async function sha(blob: Blob): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", await blob.arrayBuffer());
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
