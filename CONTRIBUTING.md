# Contributing

Thanks for helping improve ambient-memory.

## Dev setup

```bash
git clone <repo-url> ambient-memory   # or unpack the release tarball
cd ambient-memory
npm install
npm test
npm run demo
```

Requires **Node.js 20+** (22+ uses built-in `node:sqlite`; 20 uses `sql.js` WASM). No native C++ toolchain required.

## Project layout

- `src/` — daemon, store, MCP, CLI
- `test/` — unit + integration (Node test runner)
- `packaging/` — systemd / launchd examples
- `scripts/demo.ts` — end-to-end demo
- `scripts/pack-release.js` — build a transfer tarball

## Guidelines

- Keep the product **local-first** and **zero-config** on first run
- Prefer graceful degrade over hard failures (screen/browser/keychain)
- Add tests for new store / indexer / privacy behavior
- Do not commit `~/.ambient-memory` data, keys, or real browser history

## Pull requests

1. Branch from `main`
2. `npm test` must pass
3. Update `CHANGELOG.md` under an Unreleased section if user-facing
4. Keep PRs focused

## Security / privacy

If you find a secret-leak or crypto issue, open a private security advisory (or email the maintainer) rather than a public issue with exploit detail.
