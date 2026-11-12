# Security policy

## Reporting

Please use private GitHub security advisories for secret-handling or crypto issues. Do not open public issues with exploit detail.

## Threat model (summary)

Ambient Memory is **local-first**. It assumes the interactive user account is trusted. It does **not** protect against a compromised process running as the same UID while the vault is unlocked.

### What is encrypted

| Layer | Behavior |
|-------|----------|
| Entity fields (`title_enc`, `body_enc`, …) | AES-256-GCM with keychain-first (or file) master key |
| At rest (daemon stopped) | Whole DB sealed to `memory.db.enc`; plaintext + WAL/SHM removed |
| FTS5 index (`entities_fts`) | **Redacted plaintext while the daemon holds the vault open** — intentional search tradeoff, not SQLCipher |

v0.3 does **not** claim “FTS is encrypted while unlocked.” Field encryption + sealed envelope at rest is the honest story. Prefer improving to SQLCipher/WASM-encrypted FTS in a later release if needed; do not treat today’s FTS as ciphertext.

### Process model (v0.3+)

Only the **daemon** opens SQLite. CLI and `ambient mcp` are thin clients over a local Unix domain socket (Windows named pipe). That removes seal/unseal races from concurrent DB opens.

## Dependency advisories

### Zod (GHSA-mrhx-c7xc-m3w5) — mitigated

- **Issue:** Zod &lt; 4.6.6 can exhaust memory validating oversized constrained collections.
- **Exposure:** Transitive via `@modelcontextprotocol/sdk`.
- **Mitigation:** `package.json` `overrides` pins `zod` to `^4.6.7`.

### Native addons

v0.3 removes `better-sqlite3`. Storage uses Node’s built-in `node:sqlite` (Node 22+) or `sql.js` WASM (Node 20 / fallback). No `node-gyp` / MSVC toolchain required for install.
