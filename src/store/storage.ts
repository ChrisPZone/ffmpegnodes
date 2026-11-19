// localStorage keys of this app. Values saved under the old "ffng." prefix are still read.
export const storageKey = (name: string) => `ffmpegnodes.${name}`;

/** Reads a stored value, falling back to the pre-rename "ffng." key. */
export function readStored(key: string): string | null {
  try {
    return localStorage.getItem(key) ?? localStorage.getItem(key.replace(/^ffmpegnodes\./, "ffng."));
  } catch {
    return null;
  }
}
