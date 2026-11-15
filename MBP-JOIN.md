# Meta Muse MacBook Pro enrollment

Prepared 2026-11-13 for RQ-NODE-JOIN-MBP1. Node ID: `mbp-muse`;
owner scope: `masonwyatt`; hardware: 8GB MacBook Pro.

## Current evidence and blockers

No remote commands or SSH sessions were executed. Tailscale authentication was
reported pending by Mason; this session could not independently verify it.
The installed Tailscale application CLI exited with signal 5 and returned no
status JSON; `tailscale` is absent from PATH. Peer visibility and connectivity
are unverified. Router status returned schemaVersion 1, command `status`, and
an error `rejected`: local node store unavailable or invalid. Zero nodes is the
task's initial context, not a fresh measured result.

The existing Phantom CLI is 3.30.24; global upgrade failed with EPERM. This source
checkout is 3.30.32. Verify the installed command list on every device; source
support does not prove a feature is present in a published package.

## 1. On the MacBook Pro, in Mason's terminal

Install Node.js >=22.15.0 first if needed, using the Mac's existing installation
method. Then run:

```sh
node --version
git --version
gh --version
npm install -g @ashlr/phantom
phm --version
phm docs --agent --json
phm node --help
phm mcp list --json
phm wire status --json
```

If npm reports permissions errors, stop and repair the user-owned Node install;
do not use sudo or change ownership of shared fleet directories. Stop after a
failed prerequisite. Sign in locally if `gh auth status` fails:

```sh
gh auth status
gh auth login
```

Do not copy credentials or auth directories from another computer.

## 2. Complete Tailscale sign-in on both Macs

Mason opens the installed Tailscale app and completes its normal sign-in/device
approval into the same existing tailnet. Do not create keys, change ACLs, or
purchase a plan. On each Mac, inspect state:

```sh
/Applications/Tailscale.app/Contents/MacOS/Tailscale status
```

If the app CLI fails, use the app's connection/device status; do not infer that
the peer is offline from a local CLI crash. Once the MacBook Pro's exact peer
name appears, Mason can substitute that name and test the network path:

```sh
MBP_PEER='replace-with-exact-peer-name'
/Applications/Tailscale.app/Contents/MacOS/Tailscale ping --c 3 "$MBP_PEER"
```

Tailnet reachability does not prove SSH authorization. No SSH into the MacBook
Pro is authorized for this job. Agents must stop before an SSH attempt unless
Mason explicitly approves it. No peer name or IP was discovered here.

## 3. Requested local registration (optional diagnostic, not network enrollment)

Run this only on the MacBook Pro after verifying git, gh and Node above:

```sh
phm node join --node mbp-muse --owner masonwyatt --caps git,gh,node --slots 2 --json
```

This is the exact requested command. Without an existing SSH pool configuration,
it registers in the MacBook Pro's private local router only. It does not make
the node visible on another Mac. The two slots are declared router capacity;
they do not override worker RAM admission. The current SSH worker ceiling is
ONE slot on an 8GB Mac (4GiB reserve plus 4GiB per job). For an actual local
one-job pilot, use `--slots 1` instead. Do not run both joins concurrently.

Save the numeric `session` returned by join. Replace `123` below with that number:

```sh
MBP_SESSION=123
phm node beat --node mbp-muse --session "$MBP_SESSION" --slots 1 --probe-auth --json
phm node status --owner masonwyatt --json
```

Expect schemaVersion 1, command `status`, `mbp-muse` live, intended caps and
auth `ok`. A join starts neither a worker nor a heartbeat service. For a local
pilot, repeat beat within 30 seconds; rejoin after expiry using the new session.
Finish the diagnostic before configuring the SSH pool:

```sh
phm node leave --node mbp-muse --session "$MBP_SESSION" --json
```

## 4. Cross-Mac routing prerequisites and enrollment

The implemented SSH pool needs TWO distinct, explicitly approved aliases:
`primary-mac` and `backup-mac`, plus a designated backup witness. Their actual
device assignments, SSH usernames, fingerprints and readiness are unverified.
Do not assign Meta Muse both a worker and a backup identity by assumption.
Tailscale login alone does not configure this pool. Do not mount or copy node
state between machines.

Before running these commands, Mason must verify team-only SSH aliases, existing
Remote Login access and host fingerprints via a trusted channel. Each host needs
the same reviewed Phantom build, with `phm` available to noninteractive SSH.
This job configures none of those settings. Keep SSH agent forwarding disabled.

On the designated backup, once prerequisites are satisfied:

```sh
phm node pool --role backup --node backup --owner masonwyatt --primary primary-mac --backup backup-mac --json
phm node watch --json
```

On the primary, once prerequisites are satisfied:

```sh
phm node pool --role primary --node primary --owner masonwyatt --primary primary-mac --backup backup-mac --json
phm node watch --json
```

Watch runs in the foreground; keep its terminal open. The backup must witness
admissions; do not bypass an unavailable witness or reset its store.

On the MacBook Pro, after signing into each intended provider CLI locally:

```sh
phm node join --node mbp-muse --owner masonwyatt --primary primary-mac --backup backup-mac --json
phm node list --json
phm node status --json
```

This pool join probes native Codex/Claude sign-in and available capacity rather
than using `git,gh,node` as provider lanes. Inspect `registered`, `ready`, `lanes`
and `capacity`; registration alone does not mean ready. It releases its probe
session, so it need not remain live in list/status until a worker starts.
Subsequent `phm node join --json` rechecks the saved identity and route.

## 5. Worker activation is a separate handoff

No runner was commissioned, installed or started. When an absolute host-owned,
reviewed runner path is available, the documented command is:

```sh
phm node worker --runner /absolute/path/to/reviewed-node-runner --json
```

Replace that path before use. A worker executes one bounded batch, enforces the
one-slot RAM ceiling, then leaves. Memory pressure, swap, less than 20GB free disk,
unknown telemetry, PAUSE or KILL hold admission or stop work. Publication stays
on the primary. Do not modify live dispatchd, install fleet machinery, or feed
the production queue through a second uncoordinated claimant.

## Acceptance and next operator actions

1. Mason completes Tailscale sign-in on both Macs; verify peer and ping results.
2. Mason runs local prerequisite and optional registration checks on Meta Muse.
3. Establish explicit primary/backup identities and approved SSH trust, then
   verify pool registration and readiness with a matching reviewed CLI build.
4. Commission the reviewed runner and qualify a fenced synthetic job before
   declaring production compute online.

References: `docs/NODE-ROUTER.md`, `docs/add-a-computer.md`, `docs/NODES.md`,
`docs/AGENT-NETWORK.md`, and `src/cli/node-pool.ts` in the Phantom checkout.
