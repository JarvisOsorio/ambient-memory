import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  openSqliteDatabase,
  openSqliteDatabaseSync,
  type SqliteDatabase,
} from "../store/sqlite.js";

export interface BrowserHistoryEntry {
  url: string;
  title: string;
  lastVisitAt: number;
  source: string;
}

export interface BrowserIndexResult {
  indexed: number;
  skippedReason?: string;
  sourcePath?: string;
}

function candidateHistoryPaths(home = os.homedir()): Array<{ source: string; path: string }> {
  const list: Array<{ source: string; path: string }> = [
    {
      source: "chrome",
      path: path.join(home, ".config", "google-chrome", "Default", "History"),
    },
    {
      source: "chromium",
      path: path.join(home, ".config", "chromium", "Default", "History"),
    },
    {
      source: "brave",
      path: path.join(home, ".config", "BraveSoftware", "Brave-Browser", "Default", "History"),
    },
    {
      source: "chrome-mac",
      path: path.join(
        home,
        "Library",
        "Application Support",
        "Google",
        "Chrome",
        "Default",
        "History",
      ),
    },
    {
      source: "edge-mac",
      path: path.join(
        home,
        "Library",
        "Application Support",
        "Microsoft Edge",
        "Default",
        "History",
      ),
    },
    {
      source: "chrome-win",
      path: path.join(
        home,
        "AppData",
        "Local",
        "Google",
        "Chrome",
        "User Data",
        "Default",
        "History",
      ),
    },
    {
      source: "firefox",
      path: path.join(home, ".mozilla", "firefox"),
    },
    {
      source: "firefox-mac",
      path: path.join(home, "Library", "Application Support", "Firefox", "Profiles"),
    },
  ];
  return list;
}

function findFirefoxPlaces(firefoxRoot: string): string | undefined {
  if (!fs.existsSync(firefoxRoot)) return undefined;
  try {
    const entries = fs.readdirSync(firefoxRoot, { withFileTypes: true });
    for (const ent of entries) {
      if (!ent.isDirectory()) continue;
      if (!ent.name.includes(".")) continue;
      const places = path.join(firefoxRoot, ent.name, "places.sqlite");
      if (fs.existsSync(places)) return places;
    }
  } catch {
    return undefined;
  }
  return undefined;
}

function copyForRead(src: string, dest: string): boolean {
  try {
    fs.copyFileSync(src, dest);
    return true;
  } catch {
    return false;
  }
}

function detectSource(filePath: string): "chrome" | "firefox" {
  const base = path.basename(filePath).toLowerCase();
  if (base.includes("places")) return "firefox";
  return "chrome";
}

function openCopiedDb(tmp: string): SqliteDatabase {
  try {
    // Chrome visit_time is µs since 1601 — exceeds Number.MAX_SAFE_INTEGER
    return openSqliteDatabaseSync(tmp, { readBigInts: true });
  } catch {
    throw new Error(
      "Browser history read requires Node 22+ (node:sqlite) or async sql.js path — skipping",
    );
  }
}

export function readChromeFamily(
  historyPath: string,
  source: string,
  sinceMs: number,
): BrowserHistoryEntry[] {
  const tmp = path.join(os.tmpdir(), `ambient-browser-${source}-${process.pid}.db`);
  if (!copyForRead(historyPath, tmp)) return [];
  try {
    const db = openCopiedDb(tmp);
    const chromeEpochOffset = 11644473600000;
    const sinceChrome = BigInt(sinceMs + chromeEpochOffset) * 1000n;
    const rows = db
      .prepare(
        `SELECT u.url AS url, u.title AS title, MAX(v.visit_time) AS visit_time
         FROM visits v
         JOIN urls u ON u.id = v.url
         WHERE v.visit_time >= ?
         GROUP BY u.url
         ORDER BY visit_time DESC
         LIMIT 50`,
      )
      .all(sinceChrome) as Array<{ url: string; title: string; visit_time: number | bigint }>;
    db.close();
    return rows.map((r) => {
      const visit = typeof r.visit_time === "bigint" ? r.visit_time : BigInt(Number(r.visit_time));
      const ms = Number(visit / 1000n) - chromeEpochOffset;
      return {
        url: String(r.url),
        title: String(r.title || r.url),
        lastVisitAt: Math.floor(ms),
        source,
      };
    });
  } catch {
    return [];
  } finally {
    try {
      fs.unlinkSync(tmp);
    } catch {
      /* ignore */
    }
  }
}

export function readFirefox(placesPath: string, sinceMs: number): BrowserHistoryEntry[] {
  const tmp = path.join(os.tmpdir(), `ambient-browser-firefox-${process.pid}.db`);
  if (!copyForRead(placesPath, tmp)) return [];
  try {
    const db = openCopiedDb(tmp);
    const sinceUs = BigInt(sinceMs) * 1000n;
    const rows = db
      .prepare(
        `SELECT p.url AS url, COALESCE(p.title, p.url) AS title, MAX(h.visit_date) AS visit_date
         FROM moz_historyvisits h
         JOIN moz_places p ON p.id = h.place_id
         WHERE h.visit_date >= ?
         GROUP BY p.url
         ORDER BY visit_date DESC
         LIMIT 50`,
      )
      .all(sinceUs) as Array<{ url: string; title: string; visit_date: number | bigint }>;
    db.close();
    return rows.map((r) => {
      const visit = typeof r.visit_date === "bigint" ? r.visit_date : BigInt(Number(r.visit_date));
      return {
        url: String(r.url),
        title: String(r.title),
        lastVisitAt: Math.floor(Number(visit / 1000n)),
        source: "firefox",
      };
    });
  } catch {
    return [];
  } finally {
    try {
      fs.unlinkSync(tmp);
    } catch {
      /* ignore */
    }
  }
}

export function writeChromeHistoryFixture(
  destPath: string,
  visits: Array<{ url: string; title: string; visitedAtMs: number }>,
): void {
  fs.mkdirSync(path.dirname(destPath), { recursive: true });
  if (fs.existsSync(destPath)) fs.unlinkSync(destPath);
  const db = openSqliteDatabaseSync(destPath);
  db.exec(`
    CREATE TABLE urls (id INTEGER PRIMARY KEY, url TEXT, title TEXT);
    CREATE TABLE visits (id INTEGER PRIMARY KEY, url INTEGER, visit_time INTEGER);
  `);
  const chromeEpochOffset = 11644473600000;
  const insUrl = db.prepare(`INSERT INTO urls(id, url, title) VALUES (?, ?, ?)`);
  const insVisit = db.prepare(`INSERT INTO visits(id, url, visit_time) VALUES (?, ?, ?)`);
  visits.forEach((v, i) => {
    const id = i + 1;
    insUrl.run(id, v.url, v.title);
    insVisit.run(id, id, (v.visitedAtMs + chromeEpochOffset) * 1000);
  });
  db.persist();
  db.close();
}

export function writeFirefoxPlacesFixture(
  destPath: string,
  visits: Array<{ url: string; title: string; visitedAtMs: number }>,
): void {
  fs.mkdirSync(path.dirname(destPath), { recursive: true });
  if (fs.existsSync(destPath)) fs.unlinkSync(destPath);
  const db = openSqliteDatabaseSync(destPath);
  db.exec(`
    CREATE TABLE moz_places (id INTEGER PRIMARY KEY, url TEXT, title TEXT);
    CREATE TABLE moz_historyvisits (id INTEGER PRIMARY KEY, place_id INTEGER, visit_date INTEGER);
  `);
  const insPlace = db.prepare(`INSERT INTO moz_places(id, url, title) VALUES (?, ?, ?)`);
  const insVisit = db.prepare(
    `INSERT INTO moz_historyvisits(id, place_id, visit_date) VALUES (?, ?, ?)`,
  );
  visits.forEach((v, i) => {
    const id = i + 1;
    insPlace.run(id, v.url, v.title);
    insVisit.run(id, id, v.visitedAtMs * 1000);
  });
  db.persist();
  db.close();
}

/** Async fixture writers for Node 20 / sql.js environments. */
export async function writeChromeHistoryFixtureAsync(
  destPath: string,
  visits: Array<{ url: string; title: string; visitedAtMs: number }>,
): Promise<void> {
  try {
    writeChromeHistoryFixture(destPath, visits);
    return;
  } catch {
    /* fall through to async */
  }
  fs.mkdirSync(path.dirname(destPath), { recursive: true });
  if (fs.existsSync(destPath)) fs.unlinkSync(destPath);
  const db = await openSqliteDatabase(destPath);
  db.exec(`
    CREATE TABLE urls (id INTEGER PRIMARY KEY, url TEXT, title TEXT);
    CREATE TABLE visits (id INTEGER PRIMARY KEY, url INTEGER, visit_time INTEGER);
  `);
  const chromeEpochOffset = 11644473600000;
  const insUrl = db.prepare(`INSERT INTO urls(id, url, title) VALUES (?, ?, ?)`);
  const insVisit = db.prepare(`INSERT INTO visits(id, url, visit_time) VALUES (?, ?, ?)`);
  visits.forEach((v, i) => {
    const id = i + 1;
    insUrl.run(id, v.url, v.title);
    insVisit.run(id, id, (v.visitedAtMs + chromeEpochOffset) * 1000);
  });
  db.persist();
  db.close();
}

export async function writeFirefoxPlacesFixtureAsync(
  destPath: string,
  visits: Array<{ url: string; title: string; visitedAtMs: number }>,
): Promise<void> {
  try {
    writeFirefoxPlacesFixture(destPath, visits);
    return;
  } catch {
    /* fall through */
  }
  fs.mkdirSync(path.dirname(destPath), { recursive: true });
  if (fs.existsSync(destPath)) fs.unlinkSync(destPath);
  const db = await openSqliteDatabase(destPath);
  db.exec(`
    CREATE TABLE moz_places (id INTEGER PRIMARY KEY, url TEXT, title TEXT);
    CREATE TABLE moz_historyvisits (id INTEGER PRIMARY KEY, place_id INTEGER, visit_date INTEGER);
  `);
  const insPlace = db.prepare(`INSERT INTO moz_places(id, url, title) VALUES (?, ?, ?)`);
  const insVisit = db.prepare(
    `INSERT INTO moz_historyvisits(id, place_id, visit_date) VALUES (?, ?, ?)`,
  );
  visits.forEach((v, i) => {
    const id = i + 1;
    insPlace.run(id, v.url, v.title);
    insVisit.run(id, id, v.visitedAtMs * 1000);
  });
  db.persist();
  db.close();
}

export function readRecentBrowserHistory(options?: {
  home?: string;
  sinceMs?: number;
  historyPaths?: string[];
}): { entries: BrowserHistoryEntry[]; result: BrowserIndexResult } {
  const home = options?.home ?? os.homedir();
  const sinceMs = options?.sinceMs ?? Date.now() - 24 * 60 * 60 * 1000;

  if (options?.historyPaths?.length) {
    for (const p of options.historyPaths) {
      if (!fs.existsSync(p)) continue;
      const kind = detectSource(p);
      const entries =
        kind === "firefox" ? readFirefox(p, sinceMs) : readChromeFamily(p, "fixture-chrome", sinceMs);
      if (entries.length > 0) {
        return { entries, result: { indexed: entries.length, sourcePath: p } };
      }
    }
    return {
      entries: [],
      result: {
        indexed: 0,
        skippedReason: "Explicit history paths provided but no recent visits readable",
        sourcePath: options.historyPaths[0],
      },
    };
  }

  const candidates = candidateHistoryPaths(home);

  for (const c of candidates) {
    if (c.source.startsWith("firefox")) {
      const places = findFirefoxPlaces(c.path);
      if (!places) continue;
      const entries = readFirefox(places, sinceMs);
      if (entries.length > 0) {
        return {
          entries,
          result: { indexed: entries.length, sourcePath: places },
        };
      }
      return {
        entries: [],
        result: {
          indexed: 0,
          sourcePath: places,
          skippedReason: "Firefox history readable but no recent visits (or DB locked)",
        },
      };
    }

    if (!fs.existsSync(c.path)) continue;
    const entries = readChromeFamily(c.path, c.source, sinceMs);
    if (entries.length > 0) {
      return {
        entries,
        result: { indexed: entries.length, sourcePath: c.path },
      };
    }
    return {
      entries: [],
      result: {
        indexed: 0,
        sourcePath: c.path,
        skippedReason: "Browser history found but unreadable or empty for the window",
      },
    };
  }

  return {
    entries: [],
    result: {
      indexed: 0,
      skippedReason: "No local browser history DB found (optional hook skipped)",
    },
  };
}
