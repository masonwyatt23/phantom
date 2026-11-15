# Implementation findings

No drive command, driver daemon, metrics command, restock implementation or publish.sh exists in this checkout. Use an explicit versioned local file contract until the driver lands. Reuse fleet CLI dispatch and fleet digest aggregation. Keep transport responsibility with Masbot. Protected paths were inspected read-only.

---

# Routing implementation notes

- Existing src/core/decide/decide.ts provides Jev confidence, accounting, budget and kill controls.
- src/cli/route.ts currently supports route explain only.
- docs/ROUTING.md does not yet exist.
- dispatchd.py writes dispatchd.admission.v2 at end of tick.
- No companion MCP tools called.
# Onboarding findings

- Existing `onboard` first-activation and `setup` authority flows must retain their contracts.
- `phantom status --json` is configuration metadata, not vault health. Names-only
  `phantom list --json` refuses a locked file vault; partial keychain inventories
  carry a warning. Never turn a failed inventory into empty.
- Secrets import requires a trusted-terminal challenge. Offer password-manager,
  provider and other-vault imports without accepting exports or credential values.
- Lexicon supports `lexicon add <term>`; Stack MCP registers its existing CLI,
  not service provisioning. Ashlr MD has no npm/Homebrew package.
- Use existing connector metadata validation and safe-path checks. Register local
  MCP executables only; never copy credential-bearing MCP commands or environments.
- Companion tools called: none. Phantom CLI bootstrap, docs, MCP/wire/authority
  inspections were run as required by docs/AGENT-MCP-CLI.md. No runtime activated.

# RQ-LOAD-PACING-1 findings

- AIMD caps concurrency but claim_limit stays eight right up to the hard load gate.
- Use raw session metrics, excluding bundled member finishes, for pacing feedback.
- Empty/EMPTY_SIGNAL finishes cannot accelerate launch rate. Existing security gates stay authoritative.
- Fairness changes queue ordering only; market capability/quota/residency decisions still bind.
- Companion MCP tools called: none. No live installation.

- Final budget also caps rounded probes by estimated hard-ceiling headroom, including high inventory costs.
- Initial new tests had a duplicate keyword fixture error and missed reservation decay; corrected.
- Old loadgate/controller launch-count expectations updated to assert pacing plus retained target enforcement.
- Shared pnpm global virtual-store install failed ENOTEMPTY; isolated local layout succeeded with the same frozen lockfile.

- Reviewed final gate composition: pacing only tightens GCAP and effective lane targets, and rounded probes fit estimated hard headroom.
- Removed obsolete fixed claim_limit initialization; the pacing decision now owns it.
- Useful finish credit excludes unknown/failed/empty/bundle-member finishes and duplicate rows.
- Verified ISO timezone offsets and malformed timestamps; missing historical lane labels remain JSON-safe.
- Host process inspection is OS-blocked; all dispatcher verification uses synthetic process inventories.

- Host measured load1 204.7 on 18 CPUs during qualification. No host tuning or live dispatcher installation performed.
- Combined admission/event reader Vitest run passed 26 admission tests, then idle-timed out before event-reader execution (exit 124). Retrying the event-reader suite alone with unchanged runner limits.

- All 79 dispatcher tests passed. Full loadgate rerun passed 42/43: a 299-second swap sample aged out during delayed subprocess startup. Froze only the fixture subprocess clock via its temporary sitecustomize.py; added exact 300-second inclusive boundary and retained-sample assertions. Production controls unchanged.

- Full lint completed naturally, exit 1: 3 no-control-regex errors in unchanged test/leader-reply-clean-original-238s.test.ts:74,99 and test/leader-status-reply.test.ts:44; 273 warnings. Tests/config/manifests match HEAD. No JS/TS files changed; leave unrelated lint debt outside this outcome.
