#!/usr/bin/env bash
# Builds Docker image with Claude skills injected from host.
# Reads skill paths from docker-skills.conf (gitignored, one path per line).
# Skills are passed via --build-context so they never touch the repo working dir.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_DIR="$(dirname "$SCRIPT_DIR")"
CONF="$REPO_DIR/docker-skills.conf"

if [ ! -f "$CONF" ]; then
    echo "Error: docker-skills.conf not found."
    echo "Create it from the example:  cp docker-skills.conf.example docker-skills.conf"
    exit 1
fi

# Stage skills in a fresh temp dir
TMPDIR="$(mktemp -d)"
trap 'rm -rf "$TMPDIR"' EXIT

echo "=== Collecting skills ==="

while IFS= read -r line || [ -n "$line" ]; do
    # Skip comments and blank lines
    line="${line%%#*}"
    line="$(echo "$line" | xargs)"
    [ -z "$line" ] && continue

    # Expand ~/
    src="${line/#\~/$HOME}"
    name="$(basename "$src")"

    if [ -d "$src" ]; then
        echo "  $name <- $src"
        cp -r "$src" "$TMPDIR/$name"
    else
        echo "  [WARN] Not found: $src — skipping"
    fi
done < "$CONF"

echo
echo "=== Skills in Docker image ==="
for dir in "$TMPDIR"/*/; do
    [ -d "$dir" ] && echo "  - $(basename "$dir")"
done

echo
echo "=== Building Docker image ==="
cd "$REPO_DIR"
docker buildx build --build-context "skills=$TMPDIR" \
    -t claudeway-claudeway -f Dockerfile "$@" .
