import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DEFAULT_IGNORE_GLOBS } from "../../src/config/defaults.js";
import { watcherTestUtils } from "../../src/indexer/watcher.js";

describe("watcher ignore + safety", () => {
  it("ignores node_modules and .git", () => {
    assert.equal(
      watcherTestUtils.matchesIgnore("/home/u/proj/node_modules/lodash/index.js", DEFAULT_IGNORE_GLOBS),
      true,
    );
    assert.equal(
      watcherTestUtils.matchesIgnore("/home/u/proj/.git/config", DEFAULT_IGNORE_GLOBS),
      true,
    );
  });

  it("ignores secret filenames", () => {
    assert.equal(watcherTestUtils.matchesIgnore("/home/u/proj/.env", DEFAULT_IGNORE_GLOBS), true);
    assert.equal(watcherTestUtils.matchesIgnore("/home/u/proj/id_rsa", DEFAULT_IGNORE_GLOBS), true);
    assert.equal(
      watcherTestUtils.matchesIgnore("/home/u/proj/.env.example", DEFAULT_IGNORE_GLOBS),
      false,
    );
  });

  it("allows normal source files", () => {
    assert.equal(
      watcherTestUtils.matchesIgnore("/home/u/proj/src/app.ts", DEFAULT_IGNORE_GLOBS),
      false,
    );
    assert.equal(watcherTestUtils.isIndexableFile("/home/u/proj/src/app.ts"), true);
    assert.equal(watcherTestUtils.isIndexableFile("/home/u/proj/photo.png"), false);
  });

  it("exclude path prefixes work", () => {
    assert.equal(
      watcherTestUtils.isUnderExclude("/data/secrets/a.ts", ["/data/secrets"]),
      true,
    );
    assert.equal(
      watcherTestUtils.isUnderExclude("/data/src/a.ts", ["/data/secrets"]),
      false,
    );
  });
});
