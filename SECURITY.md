# Security policy

## Reporting

Please use private GitHub security advisories (once the repo is public) for secret-handling or crypto issues. Do not open public issues with exploit detail.

## Threat model (summary)

Ambient Memory is **local-first**. It assumes the interactive user account is trusted. It does **not** protect against a compromised process running as the same UID while the vault is unlocked. See README → Privacy & threat model.

## Dependency advisories

### Zod (GHSA-mrhx-c7xc-m3w5) — mitigated

- **Issue:** Zod < 4.6.6 can exhaust memory validating oversized constrained collections.
- **Exposure:** Transitive via `@modelcontextprotocol/sdk` (peer: `zod ^3.25 || ^4.0`). Ambient Memory does not import Zod directly.
- **Mitigation:** `package.json` `overrides` pins `zod` to `^4.6.7`. Verify with `npm ls zod` and `npm audit`.

If `npm audit` still reports unrelated findings after install, document them here before release rather than force-upgrading breaking majors blindly.
