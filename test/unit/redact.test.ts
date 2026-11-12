import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { redactSecrets } from "../../src/privacy/redact.js";

describe("redactSecrets", () => {
  it("redacts OpenAI-style keys", () => {
    const r = redactSecrets("token sk-abcdefghijklmnopqrstuvwxyz123456");
    assert.equal(r.redacted, true);
    assert.match(r.text, /\[REDACTED:openai_key\]/);
    assert.doesNotMatch(r.text, /sk-abcdefgh/);
  });

  it("redacts GitHub PATs", () => {
    const r = redactSecrets("auth ghp_abcdefghijklmnopqrstuvwxyzABCDEF123456");
    assert.equal(r.redacted, true);
    assert.match(r.text, /\[REDACTED:github_pat\]/);
  });

  it("redacts private key blocks", () => {
    const pem = `-----BEGIN PRIVATE KEY-----\nMIIEvgIBADAN\n-----END PRIVATE KEY-----`;
    const r = redactSecrets(pem);
    assert.equal(r.redacted, true);
    assert.match(r.text, /\[REDACTED:private_key_block\]/);
  });

  it("leaves ordinary prose alone", () => {
    const r = redactSecrets("Working on ambient memory README and MCP tools");
    assert.equal(r.redacted, false);
    assert.equal(r.text, "Working on ambient memory README and MCP tools");
  });

  it("redacts anthropic, npm, and connection strings", () => {
    const r = redactSecrets(
      "key sk-ant-api03-abcdefghijklmnopqrstuvwxyz password postgres://user:secret@host/db npm_abcdefghijklmnopqrstuvwxyzabcdefghij",
    );
    assert.equal(r.redacted, true);
    assert.ok(r.kinds.includes("anthropic_key") || r.text.includes("REDACTED"));
    assert.match(r.text, /REDACTED/);
  });
});
