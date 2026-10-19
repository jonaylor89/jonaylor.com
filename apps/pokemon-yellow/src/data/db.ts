/** Minimal promise wrapper over IndexedDB. */
export const DB_NAME = 'pokeyellow-web';
export const DB_VERSION = 1;
export const STORES = { bundle: 'derived-rom-data', saves: 'saves', settings: 'settings' } as const;

let dbPromise: Promise<IDBDatabase> | undefined;

export function openDb(factory: IDBFactory = globalThis.indexedDB): Promise<IDBDatabase> {
  if (!factory) return Promise.reject(new Error('IndexedDB is not available in this browser'));
  dbPromise ??= new Promise((resolve, reject) => {
    const req = factory.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      for (const name of Object.values(STORES)) if (!db.objectStoreNames.contains(name)) db.createObjectStore(name);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

/** For tests: forget the cached connection. */
export function resetDbConnection(): void {
  dbPromise = undefined;
}

/** Atomic read/modify/write; the updater must be synchronous. */
export async function idbUpdate<T>(store: string, key: string, update: (current: T | undefined) => T): Promise<T> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, 'readwrite');
    const objectStore = tx.objectStore(store);
    const request = objectStore.get(key);
    let result: T;
    request.onsuccess = () => {
      try { result = update(request.result as T | undefined); objectStore.put(result, key); }
      catch (error) { tx.abort(); reject(error); }
    };
    tx.oncomplete = () => resolve(result);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error ?? new Error('Storage transaction aborted'));
  });
}

export async function idbGet<T>(store: string, key: string): Promise<T | undefined> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const req = db.transaction(store, 'readonly').objectStore(store).get(key);
    req.onsuccess = () => resolve(req.result as T | undefined);
    req.onerror = () => reject(req.error);
  });
}

export async function idbPut(store: string, key: string, value: unknown): Promise<void> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, 'readwrite');
    tx.objectStore(store).put(value, key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export async function idbDelete(store: string, key: string): Promise<void> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, 'readwrite');
    tx.objectStore(store).delete(key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export async function idbKeys(store: string): Promise<string[]> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const req = db.transaction(store, 'readonly').objectStore(store).getAllKeys();
    req.onsuccess = () => resolve(req.result.map(String));
    req.onerror = () => reject(req.error);
  });
}
