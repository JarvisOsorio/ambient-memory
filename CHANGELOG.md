# Changelog

## [0.2.1] — 2026-11-12

### Fixed
- Multi-term search now uses FTS **OR** + term-coverage boosts so queries like `"founders MCP"` recall useful docs (was AND-strict)
- Seal-on-stop: CLI one-shots re-seal when the daemon is not running; stop verifies envelope; WAL/SHM removed; no plaintext beside `.enc`
- Doctor: optional missing browser is a **note**, not `ok: false`; null screen capture is flagged clearly; plaintext-beside-enc is an **issue**
- npm audit high (Zod GHSA-mrhx-c7xc-m3w5): pin `zod@^4.6.7` via overrides; document in SECURITY.md

### Added
- Seal-at-rest integration tests; FTS OR unit tests; multi-term retrieval eval
- `sealedAtRest` in status/doctor output

## [0.2.0] — 2026-11-12

Engineer-grade upgrade: FTS5/BM25, MCP get/context, ingestion hardening, threat model, context narrative.

## [0.1.0] — 2026-11-12

Initial local MVP.
