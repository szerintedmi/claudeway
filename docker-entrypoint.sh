#!/bin/bash
set -euo pipefail

REPOS_DIR="/app/.repos"
CONFIG_FILE="/app/config.yaml"

if [ ! -f "$CONFIG_FILE" ]; then
  echo "[entrypoint] No config.yaml found, skipping repo sync"
  exec "$@"
fi

# Parse repos map from config.yaml using bun
repos_json=$(bun -e "
const { readFileSync } = require('fs');
const { parse } = require('yaml');
const config = parse(readFileSync('$CONFIG_FILE', 'utf-8'));
if (config.repos) {
  console.log(JSON.stringify(config.repos));
} else {
  console.log('{}');
}
")

if [ "$repos_json" = "{}" ]; then
  echo "[entrypoint] No repos defined in config, skipping repo sync"
  exec "$@"
fi

mkdir -p "$REPOS_DIR"

# Iterate over each repo in the map
for name in $(echo "$repos_json" | bun -e "
  const json = require('fs').readFileSync('/dev/stdin', 'utf-8');
  for (const key of Object.keys(JSON.parse(json))) console.log(key);
"); do
  url=$(echo "$repos_json" | bun -e "
    const json = require('fs').readFileSync('/dev/stdin', 'utf-8');
    console.log(JSON.parse(json)['$name'].url);
  ")
  branch=$(echo "$repos_json" | bun -e "
    const json = require('fs').readFileSync('/dev/stdin', 'utf-8');
    const b = JSON.parse(json)['$name'].branch;
    if (b) console.log(b);
  ")

  repo_path="$REPOS_DIR/$name"

  if [ ! -d "$repo_path/.git" ]; then
    echo "[entrypoint] Cloning $name from $url"
    if [ -n "$branch" ]; then
      git clone --branch "$branch" "$url" "$repo_path"
    else
      git clone "$url" "$repo_path"
    fi
  else
    echo "[entrypoint] Updating $name"
    cd "$repo_path"

    stash_output=$(git stash 2>&1)
    had_stash=false
    if echo "$stash_output" | grep -q "Saved working directory"; then
      had_stash=true
      echo "[entrypoint] WARNING: $name had uncommitted changes (stashed)"
    fi

    git fetch origin

    if [ -n "$branch" ]; then
      current_branch=$(git rev-parse --abbrev-ref HEAD)
      if [ "$current_branch" != "$branch" ]; then
        git checkout "$branch"
      fi
    fi

    git pull --ff-only || echo "[entrypoint] WARNING: $name pull --ff-only failed (may need manual resolution)"

    if [ "$had_stash" = true ]; then
      echo "[entrypoint] WARNING: $name has stashed changes — run 'git stash pop' to restore"
    fi

    cd /app
  fi
done

echo "[entrypoint] Repo sync complete"
exec "$@"
