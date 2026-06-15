/**
 * modelCache — persist the (re-assembled) model bytes so the ~28 MB download is
 * a ONE-TIME cost. Stored in IndexedDB (handles tens of MB comfortably; the Cache
 * API would also work but IDB keeps us in one well-understood store).
 *
 * Tiny hand-rolled IDB wrapper — no `idb` dependency, keeps the island bundle lean.
 * Schema is intentionally trivial: a single object store keyed by a version string,
 * so bumping MODEL_KEY when the model changes auto-invalidates the old blob.
 */

const DB_NAME = "mpe-models";
const STORE = "blobs";
const DB_VERSION = 1;

/** Bump this string whenever the vendored model file changes → old cache ignored. */
export const MODEL_KEY = "migan_pipeline_v2@1";

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error("IndexedDB open failed"));
  });
}

export async function readCachedModel(key: string): Promise<ArrayBuffer | null> {
  let db: IDBDatabase;
  try {
    db = await openDb();
  } catch {
    return null; // private mode / IDB blocked → just re-download each time
  }
  try {
    return await new Promise<ArrayBuffer | null>((resolve, reject) => {
      const tx = db.transaction(STORE, "readonly");
      const req = tx.objectStore(STORE).get(key);
      req.onsuccess = () => {
        const v = req.result;
        resolve(v instanceof ArrayBuffer ? v : null);
      };
      req.onerror = () => reject(req.error);
    });
  } catch {
    return null;
  } finally {
    db.close();
  }
}

export async function writeCachedModel(key: string, bytes: ArrayBuffer): Promise<void> {
  let db: IDBDatabase;
  try {
    db = await openDb();
  } catch {
    return; // can't cache → not fatal, model still loaded this session
  }
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE, "readwrite");
      tx.objectStore(STORE).put(bytes, key);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error ?? new Error("IDB write aborted"));
    });
  } catch {
    /* swallow — caching is best-effort */
  } finally {
    db.close();
  }
}
