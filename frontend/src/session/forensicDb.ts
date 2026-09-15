/**
 * Local IndexedDB database for persistent real vehicle observations.
 * Ensures the live app works 100% offline, on Vercel preview, and across reloads
 * with zero mock data.
 */

import type { ForensicObservation } from "../../../shared/src/forensicTypes";

const DB_NAME = "roadlens-live-forensics";
const STORE_NAME = "observations";
const DB_VERSION = 1;
const MAX_STORED_RECORDS = 1000;

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === "undefined") {
      reject(new Error("IndexedDB not available"));
      return;
    }

    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.onupgradeneeded = (event) => {
      const db = (event.target as IDBOpenDBRequest).result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        const store = db.createObjectStore(STORE_NAME, { keyPath: "id" });
        store.createIndex("timestamp", "timestamp", { unique: false });
        store.createIndex("plateText", "plate.text", { unique: false });
        store.createIndex("vehicleClass", "vehicleClass", { unique: false });
        store.createIndex("cameraId", "cameraId", { unique: false });
      }
    };

    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

/**
 * Stores a real vehicle observation into IndexedDB.
 */
export async function saveObservation(obs: ForensicObservation): Promise<void> {
  try {
    const db = await openDb();
    const tx = db.transaction(STORE_NAME, "readwrite");
    const store = tx.objectStore(STORE_NAME);

    // Save observation
    store.put(obs);

    // Enforce retention limit to avoid unbounded browser storage growth
    tx.oncomplete = () => {
      pruneOldObservations(db).catch(() => {});
    };
  } catch (err) {
    console.warn("Failed to persist observation to IndexedDB:", err);
  }
}

/**
 * Prunes observations beyond the maximum retention limit.
 */
async function pruneOldObservations(db: IDBDatabase): Promise<void> {
  try {
    const tx = db.transaction(STORE_NAME, "readwrite");
    const store = tx.objectStore(STORE_NAME);
    const countReq = store.count();

    countReq.onsuccess = () => {
      if (countReq.result > MAX_STORED_RECORDS) {
        const excess = countReq.result - MAX_STORED_RECORDS;
        const index = store.index("timestamp");
        let deleted = 0;

        const cursorReq = index.openCursor();
        cursorReq.onsuccess = () => {
          const cursor = cursorReq.result;
          if (cursor && deleted < excess) {
            cursor.delete();
            deleted++;
            cursor.continue();
          }
        };
      }
    };
  } catch {
    // Ignore pruning errors
  }
}

/**
 * Retrieves all stored real observations ordered by most recent first.
 */
export async function getAllObservations(): Promise<ForensicObservation[]> {
  try {
    const db = await openDb();
    return new Promise((resolve) => {
      const tx = db.transaction(STORE_NAME, "readonly");
      const store = tx.objectStore(STORE_NAME);
      const req = store.getAll();

      req.onsuccess = () => {
        const records = (req.result as ForensicObservation[]) || [];
        records.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());
        resolve(records);
      };

      req.onerror = () => resolve([]);
    });
  } catch {
    return [];
  }
}

/**
 * Retrieves sighting history for a specific vehicle by plate text or ID.
 */
export async function getVehicleHistory(plateOrId: string): Promise<ForensicObservation[]> {
  const all = await getAllObservations();
  const target = plateOrId.toUpperCase().replace(/[^A-Z0-9]/g, "");

  return all.filter((obs) => {
    if (obs.id === plateOrId || obs.reportId === plateOrId) return true;
    if (obs.plate.text) {
      const cleanPlate = obs.plate.text.toUpperCase().replace(/[^A-Z0-9]/g, "");
      return cleanPlate.includes(target) || target.includes(cleanPlate);
    }
    return false;
  });
}

/**
 * Clears all stored observations.
 */
export async function clearObservations(): Promise<void> {
  try {
    const db = await openDb();
    const tx = db.transaction(STORE_NAME, "readwrite");
    tx.objectStore(STORE_NAME).clear();
  } catch {
    // Ignore
  }
}
