# Changelog

## [0.3.0] — 2026-11-12

### Breaking
- Removed `better-sqlite3` (native C++). Storage uses Node built-in `node:sqlite` (Node 22+) with `sql.js` WASM fallback (Node 20+)
- Daemon is the sole process that opens/seals SQLite; CLI and `ambient mcp` are thin IPC clients (Unix socket / Windows named pipe)
- Package bins: `ambient` and `ambient-memory` for `npx -y ambient-memory …`

### Added
- Aggressive context noise control: noisy-app denylist, focus dedupe, session summarization; context reports `noise` stats
- Honest crypto documentation: field encryption + sealed envelope; FTS redacted plaintext while unlocked
- IPC protocol + integration tests; noise unit + context-noise integration tests

### Fixed
- Seal/unseal races from concurrent CLI/MCP DB opens (eliminated by daemon ownership)
- Zero-config install friction from `node-gyp` / MSVC toolchains

## [0.2.1] — 2026-11-12

### Fixed
- Multi-term search now uses FTS **OR** + term-coverage boosts
- Seal-on-stop reliability; doctor honesty; Zod audit override

## [0.2.0] — 2026-11-12

Engineer-grade upgrade: FTS5/BM25, MCP get/context, ingestion hardening, threat model.

## [0.1.0] — 2026-11-12

Initial local MVP.
