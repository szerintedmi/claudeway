#!/bin/bash
set -euo pipefail

# Repo sync is now handled by the app on startup (src/sync-repos.ts)
exec "$@"
