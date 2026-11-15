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


# Heartbeat implementation notes

- Existing imessage teammate uses buildOpenAICompatibleClient at http://127.0.0.1:8123/v1, strictStreaming expectedModel fast, redirect error, bounded request/response and no tools.
- Evidence inputs: queue/status.json, queue/admission.json, dispatch-events.log, metrics/jobs.jsonl, budget-overrides.json and metrics/work-market.jsonl. Treat every source independently for freshness; never infer quiet from unavailable inputs.
- Leader integration: src/core/vision/leader.ts gatherLeaderEvidence -> buildLeaderPrompt -> leaderTick. Actions remain classified by existing leader-apply.
- No tracked leader-tick.sh and live wrapper access is denied. Provide a digest CLI for a Security-reviewed wrapper handoff without touching live files.
- No companion MCP tools called. Installed phm 3.30.31 command registry and MCP inventory read.

- Final integration smoke: a real empty-context local fast call returned healthy and persisted interval 300; no remote endpoint or credential used.
- Authority update: no new roots; deep.ts, io.ts and schema.ts join the native leader closure. Official generator added only these and heartbeat-deep.test.ts ownership.
- Baseline failures: intent_add absent from unchanged agentDocsText; MCP test mock lacks registerNativeTools; apps recovery modules already present in HEAD closure. Leader timeout passes in isolated full-module rerun.
- Full lint completed: three pre-existing no-control-regex errors at leader-reply-clean-original-238s.test.ts:74/99 and leader-status-reply.test.ts:44; those files are unchanged. No fixes or test weakening outside heartbeat scope.
