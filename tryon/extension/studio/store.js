// Tiny key-value store. Uses chrome.storage.local inside the extension (so the
// content script, side panel and in-page panel all share one wardrobe) and
// IndexedDB when the studio runs as a normal web page.
export const isExtension = !!(globalThis.chrome && chrome.storage && chrome.storage.local && chrome.runtime && chrome.runtime.id);

const listeners = new Set();

function idb() {
  if (!idb.p) {
    idb.p = new Promise((resolve, reject) => {
      const req = indexedDB.open("tryon-studio", 1);
      req.onupgradeneeded = () => req.result.createObjectStore("kv");
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  return idb.p;
}

async function tx(mode, fn) {
  const db = await idb();
  return new Promise((resolve, reject) => {
    const t = db.transaction("kv", mode);
    const r = fn(t.objectStore("kv"));
    t.oncomplete = () => resolve(r && r.result);
    t.onerror = () => reject(t.error);
  });
}

export async function get(key, fallback = null) {
  if (isExtension) {
    const r = await chrome.storage.local.get(key);
    return r[key] === undefined ? fallback : r[key];
  }
  const v = await tx("readonly", (s) => s.get(key));
  return v === undefined ? fallback : v;
}

export async function set(key, value) {
  if (isExtension) return chrome.storage.local.set({ [key]: value });
  await tx("readwrite", (s) => s.put(value, key));
}

export async function remove(key) {
  if (isExtension) return chrome.storage.local.remove(key);
  await tx("readwrite", (s) => s.delete(key));
}

/** All entries whose key starts with prefix, as [key, value] pairs. */
export async function entries(prefix) {
  if (isExtension) {
    const all = await chrome.storage.local.get(null);
    return Object.entries(all).filter(([k]) => k.startsWith(prefix));
  }
  const db = await idb();
  return new Promise((resolve, reject) => {
    const out = [];
    const req = db.transaction("kv").objectStore("kv").openCursor();
    req.onsuccess = () => {
      const c = req.result;
      if (!c) return resolve(out);
      if (String(c.key).startsWith(prefix)) out.push([c.key, c.value]);
      c.continue();
    };
    req.onerror = () => reject(req.error);
  });
}

/** cb(key, newValue) for changes made by *other* contexts (extension only). */
export function onChange(cb) {
  listeners.add(cb);
  if (isExtension && !onChange.hooked) {
    onChange.hooked = true;
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== "local") return;
      for (const [k, c] of Object.entries(changes)) listeners.forEach((fn) => fn(k, c.newValue));
    });
  }
}
