#!/bin/bash
# Foreground source runner. No launchd installation or fleet mutations.
set -eu
ROOT=$(cd "$(dirname "$0")/../.." && pwd)
exec node "$ROOT/node_modules/tsx/dist/cli.mjs" "$ROOT/src/cli/index.ts" heartbeat watch --json
