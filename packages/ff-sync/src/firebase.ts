/**
 * Firebase JS SDK implementations of the engine ports. Kept out of the core
 * entry so a host with its own native Firestore/Storage bindings can skip it.
 */

import {
  Timestamp,
  collection,
  doc,
  getDoc,
  getDocs,
  onSnapshot,
  orderBy,
  query,
  runTransaction,
  serverTimestamp,
  setDoc,
  where,
  type Firestore,
  type DocumentData,
} from "firebase/firestore";
import {
  getBytes,
  getDownloadURL,
  getMetadata,
  ref,
  uploadBytesResumable,
  type FirebaseStorage,
} from "firebase/storage";

import type { BlobTransport, RemoteChange, RemoteDocs } from "./types";

const OP_TIMEOUT_MS = 30_000;

/** Reject with a network-class error when a write never acknowledges (offline queueing). */
function withTimeout<T>(p: Promise<T>, ms = OP_TIMEOUT_MS): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => {
      const err = new Error("operation timed out") as Error & { code: string };
      err.code = "deadline-exceeded";
      reject(err);
    }, ms);
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e) => {
        clearTimeout(t);
        reject(e);
      },
    );
  });
}

const BASE = ["updatedAt", "updatedBy", "deletedAt", "schema"];

function stripBase(data: DocumentData): Record<string, unknown> {
  const out: Record<string, unknown> = { ...data };
  for (const k of BASE) delete out[k];
  return out;
}

export function createFirestoreRemote(db: Firestore): RemoteDocs {
  const docRef = (pid: string, c: string, id: string) => doc(db, "projects", pid, c, id);
  return {
    subscribe(projectId, coll, afterMs, handlers) {
      const base = collection(db, "projects", projectId, coll);
      const q =
        afterMs == null
          ? query(base, orderBy("updatedAt"))
          : query(base, where("updatedAt", ">", Timestamp.fromMillis(afterMs)), orderBy("updatedAt"));
      return onSnapshot(
        q,
        { includeMetadataChanges: true },
        (snap) => {
          const changes: RemoteChange[] = [];
          for (const ch of snap.docChanges({ includeMetadataChanges: true })) {
            if (ch.type === "removed") continue; // no hard deletes exist
            // Latency-compensated local writes: wait for the server-confirmed doc.
            if (ch.doc.metadata.hasPendingWrites) continue;
            const data = ch.doc.data();
            const ts = data.updatedAt as Timestamp | null | undefined;
            if (!ts || typeof ts.toMillis !== "function") continue;
            changes.push({
              id: ch.doc.id,
              updatedAtMs: ts.toMillis(),
              deleted: data.deletedAt != null,
              data: stripBase(data),
            });
          }
          if (changes.length > 0) handlers.onChanges(changes);
        },
        (err) => handlers.onError(err),
      );
    },
    async get(projectId, coll, id) {
      const snap = await withTimeout(getDoc(docRef(projectId, coll, id)));
      if (!snap.exists()) return null;
      const data = snap.data();
      return { deleted: data.deletedAt != null, data: stripBase(data) };
    },
    async listWhere(projectId, coll, field, value) {
      const snap = await withTimeout(
        getDocs(query(collection(db, "projects", projectId, coll), where(field, "==", value))),
      );
      return snap.docs.map((d) => stripBase(d.data()));
    },
    async upsert(projectId, coll, id, data, uid) {
      await withTimeout(
        setDoc(docRef(projectId, coll, id), {
          ...data,
          id,
          updatedAt: serverTimestamp(),
          updatedBy: uid,
          deletedAt: null,
          schema: 1,
        }),
      );
    },
    async tombstone(projectId, coll, id, uid) {
      const ref_ = docRef(projectId, coll, id);
      await withTimeout(
        runTransaction(db, async (tx) => {
          const snap = await tx.get(ref_);
          if (!snap.exists() || snap.data().deletedAt != null) return;
          tx.set(ref_, {
            ...snap.data(),
            updatedAt: serverTimestamp(),
            updatedBy: uid,
            deletedAt: serverTimestamp(),
            schema: 1,
          });
        }),
      );
    },
  };
}

export function createStorageTransport(storage: FirebaseStorage): BlobTransport {
  return {
    async head(path) {
      try {
        const m = await getMetadata(ref(storage, path));
        return { sizeBytes: m.size, sha256: m.customMetadata?.sha256 };
      } catch (err) {
        if ((err as { code?: string }).code === "storage/object-not-found") return null;
        throw err;
      }
    },
    async upload(path, blob, opts) {
      const task = uploadBytesResumable(ref(storage, path), blob, {
        contentType: opts.contentType,
        customMetadata: { sha256: opts.sha256 },
      });
      await new Promise<void>((resolve, reject) => {
        task.on(
          "state_changed",
          (s) => opts.onProgress?.(s.bytesTransferred, s.totalBytes),
          reject,
          () => resolve(),
        );
      });
    },
    async download(path) {
      // `getBytes` (not `getBlob`): works in browsers, node and native webviews.
      return new Blob([await getBytes(ref(storage, path))]);
    },
    // Streaming port: a native sink fetches this URL straight to disk.
    getDownloadUrl: (path) => getDownloadURL(ref(storage, path)),
  };
}
