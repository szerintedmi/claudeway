---
name: markitdown
description: >-
  This skill should be used when the user asks to "convert to markdown",
  "convert PDF to markdown", "convert Word to markdown", "convert DOCX",
  "convert PowerPoint", "convert PPTX", "convert Excel to markdown",
  "convert HTML to markdown", "convert image to markdown", "extract text from file",
  "markitdown", or when the user wants to convert any document, spreadsheet,
  presentation, image, or web content into Markdown format.
version: 0.1.0
---

# markitdown - Convert Files to Markdown

Convert documents, spreadsheets, presentations, images, audio, and web content to Markdown using Microsoft's [markitdown](https://github.com/microsoft/markitdown).

## Supported Formats

| Category | Formats |
|----------|---------|
| Documents | PDF, DOCX (Word), EPUB |
| Presentations | PPTX (PowerPoint) |
| Spreadsheets | XLSX, XLS (Excel), CSV |
| Web | HTML, YouTube URLs |
| Media | Images (EXIF/OCR), Audio (transcription) |
| Data | JSON, XML |
| Archives | ZIP |

## Script Location

`.claude/skills/markitdown/scripts/convert.sh`

## Prerequisites

- Python 3.10+
- `uv` (already available in this project)

The script auto-installs markitdown on first use. No manual setup needed.

### Manual Installation (if preferred)

```bash
uv tool install 'markitdown[all]'
```

## Usage

### Convert a file (output to stdout)
```bash
bash .claude/skills/markitdown/scripts/convert.sh path/to/file.pdf
```

### Convert a file to a specific output file
```bash
bash .claude/skills/markitdown/scripts/convert.sh path/to/file.pdf -o output.md
```

### Convert and save alongside the original
```bash
bash .claude/skills/markitdown/scripts/convert.sh document.docx -o document.md
```

### Batch convert multiple files
```bash
for f in *.pdf; do
  bash .claude/skills/markitdown/scripts/convert.sh "$f" -o "${f%.pdf}.md"
done
```

## Workflow

1. Run the convert script with the input file path
2. The script checks if markitdown is installed; if not, installs it via `uv tool install 'markitdown[all]'`
3. Runs `markitdown` on the input file
4. Output goes to stdout (capture or redirect) or to a file with `-o`

## Exit Codes

| Code | Meaning |
|------|---------|
| 0 | Success |
| 1 | Input file not found |
| 2 | Installation failed |
| 3 | Conversion failed |
