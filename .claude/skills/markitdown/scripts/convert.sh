#!/usr/bin/env bash
set -euo pipefail

# markitdown wrapper — auto-installs via uv if missing, then converts

usage() {
  echo "Usage: $(basename "$0") <input-file> [-o <output-file>]" >&2
  echo "" >&2
  echo "Convert files to Markdown using Microsoft markitdown." >&2
  echo "Supports: PDF, DOCX, PPTX, XLSX, XLS, CSV, HTML, JSON, XML, ZIP, EPUB, images, audio" >&2
  echo "" >&2
  echo "Options:" >&2
  echo "  -o <file>   Write output to file instead of stdout" >&2
  echo "  --help      Show this help message" >&2
  exit 0
}

# Parse arguments
INPUT_FILE=""
OUTPUT_FILE=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --help|-h) usage ;;
    -o)
      shift
      OUTPUT_FILE="${1:?'-o requires an output file path'}"
      shift
      ;;
    *)
      if [[ -z "$INPUT_FILE" ]]; then
        INPUT_FILE="$1"
        shift
      else
        echo "Error: unexpected argument '$1'" >&2
        exit 1
      fi
      ;;
  esac
done

if [[ -z "$INPUT_FILE" ]]; then
  echo "Error: no input file specified" >&2
  echo "Usage: $(basename "$0") <input-file> [-o <output-file>]" >&2
  exit 1
fi

if [[ ! -f "$INPUT_FILE" ]]; then
  echo "Error: file not found: $INPUT_FILE" >&2
  exit 1
fi

# Ensure markitdown is installed
if ! command -v markitdown &>/dev/null; then
  echo "markitdown not found. Installing via uv..." >&2
  if ! uv tool install 'markitdown[all]'; then
    echo "Error: failed to install markitdown" >&2
    exit 2
  fi
  echo "markitdown installed successfully." >&2
fi

# Run conversion
if [[ -n "$OUTPUT_FILE" ]]; then
  if ! markitdown "$INPUT_FILE" -o "$OUTPUT_FILE"; then
    echo "Error: conversion failed" >&2
    exit 3
  fi
  echo "Converted: $INPUT_FILE -> $OUTPUT_FILE" >&2
else
  if ! markitdown "$INPUT_FILE"; then
    echo "Error: conversion failed" >&2
    exit 3
  fi
fi
