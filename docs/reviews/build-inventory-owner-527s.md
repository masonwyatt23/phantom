# Build inventory owner qualification (527s)

Owner route: original job `RQ-DEVINCLOUD-BUILDINV2-N17`, branch `codex-bridge/RQ-DEVINCLOUD-BUILDINV2-N17`, PR #6618. Public PR metadata on 2026-11-17 showed open, unmerged, head `fceff1cf7291e46dd2cc5eac4e1807740dccbf2f`. Master was `54eae652080c0453b56d3f1c11c217ef433c6c99`. The supplied fleet snapshot contains no live qualification claim; live durable claim access was unavailable, so that is not proof of an unowned assignment. Return any source failure to the original owner through the existing job/branch; no live reassignment is asserted.

Content comparison (`git diff origin/master origin/qualification-6618 -- <the seven named paths>`) found all seven differ: `package.json`, `scripts/build-outputs.mjs`, `scripts/build.mjs` (new), `test/build-inventory-pack-report.test.ts` (new), `test/build-outputs.test.ts`, `test/fixtures/build-inventory-pack-report/umask-077.json` (new), and `test/gate.test.ts`. The unique correction replaces the package build chain with the owner's runner, runs steps under umask 022, restores the caller mask, and normalizes declared output modes after success while avoiding symlinks. These are the owner's source changes, including protected build and test paths, not changes made by this qualification.

Master already declares release outputs and tests that inventory against ignored/untracked paths and the build chain. It lacks the new runner and its explicit mask restoration and post-build normalization; it therefore cannot satisfy this runner qualification as written. This comparison does not establish that every master-generated artifact is unreadable: individual build tools may set their own modes.

The reviewable evidence is `test/build-inventory-owner-qualification-527s.test.ts`. It explicitly requires `BUILD_INVENTORY_OWNER_SOURCE`, because master has no runner to import; do not add it to an ordinary master test run without providing the extracted owner source or adapting it when the source lands. The child process uses only an injected fake runner in a scratch tree. It checks successful and failed/throwing runner paths restore umask 077, declared directory and file readability, executable intent, and that a symlink to an external directory leaves its target mode and content unchanged. It does not run a build.

Reproduce against the exact owner commit (with that commit fetched):

```sh
mkdir -p /tmp/phantom-owner-527s
git archive fceff1cf7291e46dd2cc5eac4e1807740dccbf2f scripts/build.mjs scripts/build-outputs.mjs | tar -x -C /tmp/phantom-owner-527s
BUILD_INVENTORY_OWNER_SOURCE=/tmp/phantom-owner-527s HOME=$(mktemp -d) npm run test:ci -- test/build-inventory-owner-qualification-527s.test.ts
```

Result: 1 test passed, 0 failed. No source failure was found in these cases. This is source-fixture evidence only, not a signed desktop release, installation, or usable installed-app qualification; those remain to be demonstrated through the sanctioned release and custody workflow. The live assignment and lint/typecheck limitations are recorded in the bridge notes.
