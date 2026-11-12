/**
 * Context noise control — ignore chat/music shells, dedupe focus churn,
 * and summarize sessions so memory_context stays signal-heavy.
 */
import { DEFAULT_NOISY_APPS } from "../config/defaults.js";

export { DEFAULT_NOISY_APPS };

export interface FocusSample {
  appName: string;
  windowTitle: string;
  capturedAt: number;
}

export interface SessionLike {
  id: string;
  title: string;
  lastSeenAt: number;
  metadata?: Record<string, unknown>;
}

export interface SummarizedSession {
  id: string;
  title: string;
  appName: string;
  windowTitle: string;
  lastSeenAt: number;
  focusCount: number;
  /** Milliseconds spanned by collapsed samples (best-effort). */
  durationMs: number;
  noisy: boolean;
}

function normalizeApp(appName: string): string {
  return appName.trim().toLowerCase();
}

export function isNoisyApp(
  appName: string,
  extra: readonly string[] = DEFAULT_NOISY_APPS,
): boolean {
  const n = normalizeApp(appName);
  if (!n) return true;
  return extra.some((a) => {
    const t = normalizeApp(a);
    return n === t || n.includes(t) || t.includes(n);
  });
}

export function parseSessionTitle(title: string): { appName: string; windowTitle: string } {
  const idx = title.indexOf(": ");
  if (idx <= 0) return { appName: title.trim() || "unknown", windowTitle: "" };
  return {
    appName: title.slice(0, idx).trim(),
    windowTitle: title.slice(idx + 2).trim(),
  };
}

/** Stable key for deduping rapid identical focus events. */
export function focusDedupeKey(sample: FocusSample): string {
  return `${normalizeApp(sample.appName)}|${sample.windowTitle.trim().toLowerCase()}`;
}

/**
 * Returns false when this focus sample should not create a new session entity
 * (noisy app, or same focus within dedupe window).
 */
export function shouldIndexFocus(
  sample: FocusSample,
  opts: {
    lastKey?: string;
    lastAt?: number;
    dedupeWindowMs?: number;
    noisyApps?: readonly string[];
    /** When true, still record noisy apps but mark them (caller decides). Default: skip. */
    keepNoisy?: boolean;
  } = {},
): { index: boolean; reason?: string; noisy: boolean } {
  const noisy = isNoisyApp(sample.appName, opts.noisyApps ?? DEFAULT_NOISY_APPS);
  if (noisy && !opts.keepNoisy) {
    return { index: false, reason: "noisy_app", noisy: true };
  }
  const key = focusDedupeKey(sample);
  const windowMs = opts.dedupeWindowMs ?? 60_000;
  if (opts.lastKey === key && opts.lastAt != null && sample.capturedAt - opts.lastAt < windowMs) {
    return { index: false, reason: "deduped", noisy };
  }
  return { index: true, noisy };
}

/**
 * Collapse consecutive same-app (or identical title) sessions into summaries,
 * dropping noisy apps unless includeNoisy is set.
 */
export function summarizeSessions(
  sessions: SessionLike[],
  opts: { includeNoisy?: boolean; noisyApps?: readonly string[] } = {},
): SummarizedSession[] {
  const noisyApps = opts.noisyApps ?? DEFAULT_NOISY_APPS;
  const sorted = [...sessions].sort((a, b) => b.lastSeenAt - a.lastSeenAt);
  const out: SummarizedSession[] = [];

  for (const s of sorted) {
    const { appName, windowTitle } = parseSessionTitle(s.title);
    const fromMeta =
      typeof s.metadata?.appName === "string" ? String(s.metadata.appName) : appName;
    const noisy = isNoisyApp(fromMeta, noisyApps);
    if (noisy && !opts.includeNoisy) continue;

    const prev = out[out.length - 1];
    const sameApp = prev && normalizeApp(prev.appName) === normalizeApp(fromMeta);
    const sameTitle = prev && prev.title === s.title;
    if (prev && (sameTitle || sameApp)) {
      prev.focusCount += 1;
      prev.durationMs = Math.max(prev.durationMs, Math.abs(prev.lastSeenAt - s.lastSeenAt));
      if (s.lastSeenAt > prev.lastSeenAt) {
        prev.lastSeenAt = s.lastSeenAt;
        prev.title = s.title;
        prev.windowTitle = windowTitle || prev.windowTitle;
        prev.id = s.id;
      }
      continue;
    }

    out.push({
      id: s.id,
      title: s.title,
      appName: fromMeta,
      windowTitle,
      lastSeenAt: s.lastSeenAt,
      focusCount: 1,
      durationMs: 0,
      noisy,
    });
  }

  return out;
}

/** Drop near-duplicate URLs / titles within a short window for context lists. */
export function dedupeByTitlePath<T extends { title: string; path?: string; lastSeenAt: number }>(
  items: T[],
  windowMs = 5 * 60_000,
): T[] {
  const out: T[] = [];
  for (const item of items) {
    const key = `${item.title.trim().toLowerCase()}|${(item.path ?? "").toLowerCase()}`;
    const dup = out.find(
      (x) =>
        `${x.title.trim().toLowerCase()}|${(x.path ?? "").toLowerCase()}` === key &&
        Math.abs(x.lastSeenAt - item.lastSeenAt) < windowMs,
    );
    if (dup) continue;
    out.push(item);
  }
  return out;
}
