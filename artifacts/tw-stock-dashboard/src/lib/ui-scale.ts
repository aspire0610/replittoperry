export const UI_SCALE_STORAGE_KEY = "tw-stock-dashboard-ui-scale-v1";
export const DEFAULT_UI_SCALE = 100;
export const MIN_UI_SCALE = 80;
export const MAX_UI_SCALE = 125;
export const UI_SCALE_STEP = 5;

export function normalizeUiScale(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_UI_SCALE;
  const stepped = Math.round(value / UI_SCALE_STEP) * UI_SCALE_STEP;
  return Math.min(MAX_UI_SCALE, Math.max(MIN_UI_SCALE, stepped));
}

export function readUiScale(): number {
  try {
    const stored = window.localStorage.getItem(UI_SCALE_STORAGE_KEY);
    if (stored === null) return DEFAULT_UI_SCALE;
    return normalizeUiScale(Number(stored));
  } catch {
    return DEFAULT_UI_SCALE;
  }
}

export function applyUiScale(value: number, persist = true): number {
  const scale = normalizeUiScale(value);
  const root = document.documentElement;
  root.style.zoom = String(scale / 100);
  root.dataset.uiScale = String(scale);

  if (persist) {
    try {
      window.localStorage.setItem(UI_SCALE_STORAGE_KEY, String(scale));
    } catch {
      // The preference still applies for this page even if storage is unavailable.
    }
  }

  return scale;
}

export function initializeUiScale(): void {
  applyUiScale(readUiScale(), false);
  window.addEventListener("storage", (event) => {
    if (event.key !== UI_SCALE_STORAGE_KEY) return;
    applyUiScale(
      event.newValue === null
        ? DEFAULT_UI_SCALE
        : Number(event.newValue),
      false,
    );
  });
}
