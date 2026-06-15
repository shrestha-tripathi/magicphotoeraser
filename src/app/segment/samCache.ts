/**
 * samCache — persist the SlimSAM model bytes so the ~40 MB download (encoder +
 * decoder) is a ONE-TIME cost. Reuses the same hand-rolled IndexedDB store
 * pattern as the inpaint modelCache, but with per-file keys so the encoder and
 * decoder are cached independently.
 *
 * Private-mode safe: every op degrades to "just re-download" if IDB is blocked.
 */

const DB_NAME = "mpe-models";
const STORE = "blobs";
const DB_VERSION = 1;

/** Bump the version suffix when a vendored SAM file changes → old cache ignored. */
export const SAM_ENCODER_KEY = "slimsam_vision_encoder@1";
export const SAM_DECODER_KEY = "slimsam_prompt_encoder_mask_decoder@1";

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

export async function readCachedSam(key: string): Promise<ArrayBuffer | null> {
  let db: IDBDatabase;
  try {
    db = await openDb();
  } catch {
    return null;
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

export async function writeCachedSam(key: string, bytes: ArrayBuffer): Promise<void> {
  let db: IDBDatabase;
  try {
    db = await openDb();
  } catch {
    return;
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
    /* best-effort */
  } finally {
    db.close();
  }
}
