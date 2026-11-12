import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  dedupeByTitlePath,
  isNoisyApp,
  shouldIndexFocus,
  summarizeSessions,
} from "../../src/indexer/noise.js";

describe("noise control", () => {
  it("flags Slack/Spotify/Zoom as noisy", () => {
    assert.equal(isNoisyApp("Slack"), true);
    assert.equal(isNoisyApp("Spotify"), true);
    assert.equal(isNoisyApp("zoom.us"), true);
    assert.equal(isNoisyApp("Cursor"), false);
    assert.equal(isNoisyApp("Code"), false);
  });

  it("skips noisy apps and dedupes identical focus", () => {
    const noisy = shouldIndexFocus({
      appName: "Slack",
      windowTitle: "#general",
      capturedAt: 1000,
    });
    assert.equal(noisy.index, false);
    assert.equal(noisy.reason, "noisy_app");

    const first = shouldIndexFocus({
      appName: "Cursor",
      windowTitle: "app.ts",
      capturedAt: 2000,
    });
    assert.equal(first.index, true);

    const dup = shouldIndexFocus(
      { appName: "Cursor", windowTitle: "app.ts", capturedAt: 2500 },
      { lastKey: "cursor|app.ts", lastAt: 2000, dedupeWindowMs: 60_000 },
    );
    assert.equal(dup.index, false);
    assert.equal(dup.reason, "deduped");
  });

  it("summarizes sessions: drops noise and collapses same-app churn", () => {
    const now = Date.now();
    const summarized = summarizeSessions([
      { id: "1", title: "Slack: #eng", lastSeenAt: now, metadata: { appName: "Slack" } },
      { id: "2", title: "Cursor: a.ts", lastSeenAt: now - 1000, metadata: { appName: "Cursor" } },
      { id: "3", title: "Cursor: b.ts", lastSeenAt: now - 2000, metadata: { appName: "Cursor" } },
      { id: "4", title: "Spotify: lofi", lastSeenAt: now - 3000, metadata: { appName: "Spotify" } },
      {
        id: "5",
        title: "Firefox: docs",
        lastSeenAt: now - 4000,
        metadata: { appName: "Firefox" },
      },
    ]);
    assert.ok(!summarized.some((s) => /slack|spotify/i.test(s.appName)));
    const cursor = summarized.find((s) => s.appName === "Cursor");
    assert.ok(cursor);
    assert.ok(cursor!.focusCount >= 2);
    assert.ok(summarized.length <= 3);
  });

  it("dedupes title/path within window", () => {
    const items = dedupeByTitlePath([
      { title: "a.md", path: "/a.md", lastSeenAt: 1000 },
      { title: "a.md", path: "/a.md", lastSeenAt: 2000 },
      { title: "b.md", path: "/b.md", lastSeenAt: 3000 },
    ]);
    assert.equal(items.length, 2);
  });
});
