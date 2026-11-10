# Nodes view

See every computer that joined this Phantom fleet: its role, capabilities,
how long ago it last checked in, which jobs it is running, and which one holds
the leader lease. It appears in the desktop app on the Fleet Dashboard (the
Mission Control view) as a **Nodes** panel, and in the terminal as `phm nodes`
(`ashlr fleet nodes` prints the same projection).

Each node uses only its own local login. Nothing here copies, sends or shows a
token; a node reports only the state of its own GitHub login
(`ok`, `missing` or `unknown`).

## Copy-paste example

```bash
phm nodes
phm nodes --json
phm nodes --json --now 2026-11-02T12:00:30Z   # fixed clock, repeatable output
```

Human output (one line per node, `★` marks the leader):

```text
Nodes (2) · leader: mac-mini-1 · source: /Users/you/.ashlr/nodes/nodes.json · observed: 2026-11-02T12:00:00.000Z
   lima-vm-2  worker  stale  heartbeat 4m  jobs 0  gh-auth unknown  caps os:linux
★  mac-mini-1  leader  ready  heartbeat 30s  jobs 2  gh-auth ok  caps gh,os:darwin
```

`--json` prints one object, `phantom.nodes.v1`: `generatedAt`, `sourcePath`,
`observedAt`, `leaderId`, `nodes[]` (`id`, `role`, `owners`, `caps`, `status`,
`heartbeatAt`, `heartbeatAgeMs`, `liveJobs`, `ghAuth`, `leader`, `source`) and
`error` (`null` when the inventory read cleanly). Nodes are sorted by id and
time comes from one clock reading, so the same inputs give the same bytes.

## Where the data comes from

The view reads one registry file, `<ASHLR_HOME>/nodes/nodes.json` (honours
`ASHLR_HOME`), written by the node router's local store on every heartbeat. It
is a `drive.nodes.v1` document: `nodes[]` carry `nodeId`, `session`,
`heartbeatAt`, `expiresAt`, optional `owners`, `caps`, `usage`, `slots` and
`auth`; `leader` is the current `LeaderLease` (`nodeId`, `session`, `token`,
`expiresAt`); `jobs[]` are the queued claims. See
[docs/NODE-ROUTER.md](NODE-ROUTER.md) for how a computer joins
(`phm node join`) and how the lease fences work.

The leader badge shows only while the lease is unexpired and the holder's own
session is still live; a node that is not the lease holder shows its router
role (`worker`, or `standby` for the pool backup).

Status: `ready` (heartbeat within 90 s), `stale` (within 5 min), `down`
(older), `unknown` (no heartbeat).

## Safety and errors

- Read-only. The registry is parsed with a strict validator
  (`src/core/drive/nodes/state.ts`); a record holding a secret-shaped value
  fails validation and the whole inventory is reported as `error`, never
  partially trusted.
- `phm nodes` exits 0 when the view is readable, 1 when the inventory is
  missing, malformed or fails validation (`error` names which), 2 for bad
  arguments.
- If the registry is missing, `nodes` is empty and `error` says
  `inventory missing`. Nothing is invented.

The web console reads the same projection over `GET /api/nodes`, in the same
read class as `/api/control`.
