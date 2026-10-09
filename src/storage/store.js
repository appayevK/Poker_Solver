// Persistence for hands, notes, tags and edited ranges.
// Starts with localStorage (wrapped in try/catch); can move to IndexedDB for large hand libraries.

export function load(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch {
    return fallback;
  }
}

export function save(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // storage unavailable or full
  }
}
