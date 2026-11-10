# Devin-hosted GLM Lite smoke (RQ-PHOS-7-GLMLITE-SMOKE)

Status: **failed closed — no smoke run, no sub-lane enabled, no spend.** GLM
Lite could not be confirmed Free (or present) on the Devin surface, so step 2
of the job applied: record the evidence and stop.

Scope and naming follow the surfaces-vs-models framing used by
RQ-PHOS-1-DESIGN / RQ-PHOS-2-REGISTRY: **Devin is the surface**, **GLM Lite is
the hosted model**, and the Devin → GLM Lite relationship would be a
first-class hosted edge — a sub-lane of the existing `devin` lane, not a new
fleet agent and not a Devin "app".

## Free-tier verification

- Command: `devin models list` (Devin CLI `3000.12.32 (1126aba4a596)`,
  installed via Homebrew at `/opt/homebrew/bin/devin`), run 2026-11-10 on the
  local account.
- Source of truth: the account's live model catalog printed by that command;
  the CLI's own docs (`models.mdx` shipped with the cask) name GLM among the
  supported open-source families but publish no tier table.
- Cost-tier equivalent: Devin prints each model's cost inline in brackets —
  either `Free` or per-token rates (`$X / 1M Input · $Y / 1M Cached input ·
  $Z / 1M Output`). That bracket is the documented equivalent of `cost_tier`.

### Finding

The catalog lists **no model named or aliased "GLM Lite"** (a case-insensitive
search of the full 49-family listing for `lite` returns nothing). Every GLM
entry that does exist carries metered per-token pricing — none carries `Free`:

| Family | Model UIDs | Cost tier (as printed) |
| --- | --- | --- |
| GLM-5.2 | `glm-5-2`, `glm-5-2-max`, `glm-5-2-1m`, `glm-5-2-max-1m`, `glm-5-2-none`, `glm-5-2-none-1m` | metered ($1.4 / 1M input · $0.26 / 1M cached · $4.4 / 1M output) |
| GLM-5.3 | `glm-5-3-low`, `glm-5-3-high`, `glm-5-3-max` | metered ($1.4 / 1M input · $0.26 / 1M cached · $4.4 / 1M output) |
| GLM-5.3 Flash | `glm-5-3-flash-low`, `glm-5-3-flash-high`, `glm-5-3-flash-max` | metered ($0.15 / 1M input · $0.03 / 1M cached · $0.5 / 1M output) |
| Fusion sidekicks | `fusion-*-sidekick-glm-5-2` (many entries) | metered sidekick rates on top of the lead model's price |

The only `Free` markers in the catalog belong to the SWE-2 and SWE-2 Flash
families, plus `Sidekick: Free` on Fusion entries whose sidekick is a free
SWE-2 model. No GLM variant qualifies.

Separately, the real-world product named "GLM Lite" — Z.ai's GLM Coding Plan
**Lite** tier — is a paid subscription (published at $18/month, less on
annual billing), and Phantom already maps it to the existing `zai` lane; see
[docs/lanes/zai.md](../lanes/zai.md). It is not a free model on any surface.

## Decision

Fail closed, as required. Because no Free (or even present) GLM Lite model
exists on the Devin surface:

- no Devin job was launched against GLM Lite;
- no sub-lane, queue tier, registry entry or config flag enabling it was
  added;
- nothing was spent, and no paid or `--cloud` path was exercised;
- no PR turning it on was opened.

## Re-open conditions

Revisit only if `devin models list` on the account shows a GLM variant with
the `Free` marker (or Cognition documents an included GLM tier on Devin), at
which point a minimal sub-lane smoke of the Devin → GLM Lite edge may run
under the same included-quota-only limits. The existing `zai` lane already
covers the paid Z.ai GLM Coding Lite path and needs no duplicate.
