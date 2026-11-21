# Publishing ambient-memory to npm

**Status (2026-11-13):** package is **not** on npm. Cloud agents hit `ENEEDAUTH` (not logged in to the registry). Do **not** advertise working `npx -y ambient-memory` until publish succeeds.

## Jarvis — exact steps

On a machine where you can complete npm login / OTP (or with an Automation token that has publish rights for `ambient-memory`):

```bash
git clone https://github.com/JarvisOsorio/ambient-memory.git
cd ambient-memory
git checkout main
git pull
npm ci
npm test          # expect tests green (60 in recent runs)
npm login         # or: npm config set //registry.npmjs.org/:_authToken=YOUR_TOKEN
npm publish --access public
npm view ambient-memory version   # → 0.3.0
```

Then verify:

```bash
npx -y ambient-memory@0.3.0 --help
npx -y ambient-memory doctor
```

Until those succeed, install from source (see README / [project page](https://jarvisosorio.com/ambient-memory/)).

GitHub release tag `v0.3.0` already points at main; recreate only if needed after publish polish.
