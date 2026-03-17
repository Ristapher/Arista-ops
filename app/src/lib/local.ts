
import type { AppState, Health } from "./api";

const DB_NAME = "arista-ops-offline";
const DB_VERSION = 1;
const STORE = "kv";
const FALLBACK_KEY = "arista-ops-offline-cache";

export type OfflineCache = {
  state: AppState | null;
  health: Health | null;
  pendingSync: boolean;
  pendingEmailQueue: PendingEmailJob[];
  updatedAt: string | null;
};

export type PendingEmailJob = {
  id: string;
  payload: {
    to_email: string;
    customer_name: string;
    amount: number;
    status: string;
    job_number?: string;
    notes?: string;
    payment_url?: string;
  };
};

const EMPTY_CACHE: OfflineCache = {
  state: null,
  health: null,
  pendingSync: false,
  pendingEmailQueue: [],
  updatedAt: null,
};

function supportsIndexedDb() {
  return typeof indexedDB !== "undefined";
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE);
      }
    };

    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("Failed to open IndexedDB."));
  });
}

async function idbGet<T>(key: string): Promise<T | null> {
  const db = await openDb();

  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, "readonly");
    const store = tx.objectStore(STORE);
    const request = store.get(key);

    request.onsuccess = () => resolve((request.result as T | undefined) ?? null);
    request.onerror = () => reject(request.error ?? new Error("Failed to read IndexedDB."));
  });
}

async function idbSet<T>(key: string, value: T): Promise<void> {
  const db = await openDb();

  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite");
    const store = tx.objectStore(STORE);
    store.put(value, key);

    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error("Failed to write IndexedDB."));
    tx.onabort = () => reject(tx.error ?? new Error("IndexedDB transaction aborted."));
  });
}

function localStorageGet(): OfflineCache {
  try {
    const raw = localStorage.getItem(FALLBACK_KEY);
    return raw ? { ...EMPTY_CACHE, ...JSON.parse(raw) } : EMPTY_CACHE;
  } catch {
    return EMPTY_CACHE;
  }
}

function localStorageSet(value: OfflineCache) {
  localStorage.setItem(FALLBACK_KEY, JSON.stringify(value));
}

export async function readOfflineCache(): Promise<OfflineCache> {
  if (!supportsIndexedDb()) {
    return localStorageGet();
  }

  try {
    const value = await idbGet<OfflineCache>("cache");
    return value ? { ...EMPTY_CACHE, ...value } : EMPTY_CACHE;
  } catch {
    return localStorageGet();
  }
}

export async function writeOfflineCache(patch: Partial<OfflineCache>): Promise<OfflineCache> {
  const current = await readOfflineCache();
  const next: OfflineCache = {
    ...current,
    ...patch,
    updatedAt: new Date().toISOString(),
  };

  if (!supportsIndexedDb()) {
    localStorageSet(next);
    return next;
  }

  try {
    await idbSet("cache", next);
  } catch {
    localStorageSet(next);
  }

  return next;
}

export async function cacheState(state: AppState | null): Promise<void> {
  await writeOfflineCache({ state });
}

export async function cacheHealth(health: Health | null): Promise<void> {
  await writeOfflineCache({ health });
}

export async function markPendingSync(state: AppState): Promise<void> {
  await writeOfflineCache({ state, pendingSync: true });
}

export async function clearPendingSync(state: AppState): Promise<void> {
  await writeOfflineCache({ state, pendingSync: false });
}

export async function enqueueEmail(job: PendingEmailJob): Promise<void> {
  const cache = await readOfflineCache();
  await writeOfflineCache({
    pendingEmailQueue: [...cache.pendingEmailQueue.filter((item) => item.id !== job.id), job],
  });
}

export async function removeQueuedEmail(id: string): Promise<void> {
  const cache = await readOfflineCache();
  await writeOfflineCache({
    pendingEmailQueue: cache.pendingEmailQueue.filter((item) => item.id !== id),
  });
}
