import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { buildConfig } from "../../src/config/defaults.js";
import {
  readRecentBrowserHistory,
  writeChromeHistoryFixture,
  writeFirefoxPlacesFixture,
} from "../../src/indexer/browser.js";
import { AmbientDaemon } from "../../src/indexer/daemon.js";
import {
  probeScreen,
  resolveScreenProvider,
  SimulatedScreenProvider,
} from "../../src/indexer/screen.js";

describe("browser fixtures + screen providers", () => {
  let fixtureDir: string;
  let chromePath: string;
  let firefoxPath: string;

  before(() => {
    fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), "ambient-browser-fix-"));
    chromePath = path.join(fixtureDir, "History");
    firefoxPath = path.join(fixtureDir, "places.sqlite");
    const now = Date.now();
    writeChromeHistoryFixture(chromePath, [
      {
        url: "https://example.com/ambient-chrome",
        title: "Ambient Chrome Fixture",
        visitedAtMs: now - 60_000,
      },
    ]);
    writeFirefoxPlacesFixture(firefoxPath, [
      {
        url: "https://example.com/ambient-firefox",
        title: "Ambient Firefox Fixture",
        visitedAtMs: now - 30_000,
      },
    ]);
  });

  it("reads Chrome history fixture", () => {
    const { entries, result } = readRecentBrowserHistory({
      historyPaths: [chromePath],
      sinceMs: Date.now() - 24 * 60 * 60 * 1000,
    });
    assert.ok(result.indexed >= 1);
    assert.ok(entries.some((e) => e.title.includes("Chrome Fixture")));
  });

  it("reads Firefox places fixture", () => {
    const { entries, result } = readRecentBrowserHistory({
      historyPaths: [firefoxPath],
      sinceMs: Date.now() - 24 * 60 * 60 * 1000,
    });
    assert.ok(result.indexed >= 1);
    assert.ok(entries.some((e) => e.title.includes("Firefox Fixture")));
  });

  it("skips cleanly with no history", () => {
    const emptyHome = fs.mkdtempSync(path.join(os.tmpdir(), "ambient-no-browser-"));
    const { result } = readRecentBrowserHistory({ home: emptyHome });
    assert.equal(result.indexed, 0);
    assert.match(result.skippedReason ?? "", /No local browser history/);
  });

  it("simulated screen always captures", async () => {
    const p = await resolveScreenProvider("simulated", new SimulatedScreenProvider());
    const snap = await p.capture();
    assert.ok(snap);
    assert.equal(snap.provider, "simulated");
  });

  it("probeScreen returns structured diagnostics", async () => {
    const probe = await probeScreen("simulated");
    assert.equal(probe.resolved, "simulated");
    assert.ok(probe.sample);
    assert.ok(probe.note.length > 0);
  });

  it("auto degrades to none without display tools on headless", async () => {
    const p = await resolveScreenProvider("auto");
    // On this CI/headless VM we expect none (no xdotool/display) or xdotool if present
    assert.ok(["none", "xdotool", "osascript"].includes(p.name));
  });

  it("daemon indexes browser fixtures", async () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "ambient-daemon-browser-"));
    const workspace = path.join(dataDir, "ws");
    fs.mkdirSync(workspace);
    const config = buildConfig({
      dataDir,
      watchRoots: [workspace],
      screenProvider: "simulated",
      screenIntervalMs: 10_000,
      browserEnabled: true,
      forceFileKey: true,
      browserHistoryPaths: [chromePath],
    });
    const daemon = new AmbientDaemon(config);
    await daemon.start();
    try {
      assert.ok((daemon.browserNote?.indexed ?? 0) >= 1);
      const hits = daemon.store.search("Ambient Chrome");
      assert.ok(hits.length >= 1);
      assert.equal(hits[0]!.entity.type, "url");
    } finally {
      await daemon.stop(false);
    }
  });
});
