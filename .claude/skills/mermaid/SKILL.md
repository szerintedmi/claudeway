---
name: mermaid
description: Generate Mermaid diagrams from user requirements. Supports flowcharts, sequence diagrams, class diagrams, ER diagrams, Gantt charts, and 18 more diagram types.
allowed-tools: Read Write Edit Bash
metadata:
  argument-hint: "[diagram description or requirements]"
---

# Mermaid Diagram Generator

Generate high-quality Mermaid diagram code based on user requirements.

## Workflow

1. **Understand Requirements**: Analyze user description to determine the most suitable diagram type
2. **Read Documentation**: Read the corresponding syntax reference for the diagram type
3. **Generate Code**: Generate Mermaid code following the specification
4. **Apply Styling**: Apply appropriate themes and style configurations
5. **Validate with mmdc**: Validate the generated diagram compiles correctly (see [Validation](#validation) below)

## Diagram Type Reference

Select the appropriate diagram type and read the corresponding documentation:

| Type | Documentation | Use Cases |
| ---- | ------------- | --------- |
| Flowchart | [flowchart.md](references/flowchart.md) | Processes, decisions, steps |
| Sequence Diagram | [sequenceDiagram.md](references/sequenceDiagram.md) | Interactions, messaging, API calls |
| Class Diagram | [classDiagram.md](references/classDiagram.md) | Class structure, inheritance, associations |
| State Diagram | [stateDiagram.md](references/stateDiagram.md) | State machines, state transitions |
| ER Diagram | [entityRelationshipDiagram.md](references/entityRelationshipDiagram.md) | Database design, entity relationships |
| Gantt Chart | [gantt.md](references/gantt.md) | Project planning, timelines |
| Pie Chart | [pie.md](references/pie.md) | Proportions, distributions |
| Mindmap | [mindmap.md](references/mindmap.md) | Hierarchical structures, knowledge graphs |
| Timeline | [timeline.md](references/timeline.md) | Historical events, milestones |
| Git Graph | [gitgraph.md](references/gitgraph.md) | Branches, merges, versions |
| Quadrant Chart | [quadrantChart.md](references/quadrantChart.md) | Four-quadrant analysis |
| Requirement Diagram | [requirementDiagram.md](references/requirementDiagram.md) | Requirements traceability |
| C4 Diagram | [c4.md](references/c4.md) | System architecture (C4 model) |
| Sankey Diagram | [sankey.md](references/sankey.md) | Flow, conversions |
| XY Chart | [xyChart.md](references/xyChart.md) | Line charts, bar charts |
| Block Diagram | [block.md](references/block.md) | System components, modules |
| Packet Diagram | [packet.md](references/packet.md) | Network protocols, data structures |
| Kanban | [kanban.md](references/kanban.md) | Task management, workflows |
| Architecture Diagram | [architecture.md](references/architecture.md) | System architecture |
| Radar Chart | [radar.md](references/radar.md) | Multi-dimensional comparison |
| Treemap | [treemap.md](references/treemap.md) | Hierarchical data visualization |
| User Journey | [userJourney.md](references/userJourney.md) | User experience flows |
| ZenUML | [zenuml.md](references/zenuml.md) | Sequence diagrams (code style) |

## Configuration & Themes

- [Theming](references/config-theming.md) - Custom colors and styles
- [Directives](references/config-directives.md) - Diagram-level configuration
- [Layouts](references/config-layouts.md) - Layout direction and spacing
- [Configuration](references/config-configuration.md) - Global settings
- [Math](references/config-math.md) - LaTeX math support

## Validation

After generating the Mermaid code, validate it compiles correctly using `mmdc` (Mermaid CLI).

### Steps

1. **Check if mmdc is available** by running `command -v mmdc`. If not found, skip validation and tell the user:

   > Mermaid CLI (`mmdc`) is not installed, so I couldn't validate the diagram. To enable validation, install it with:
   >
   > ```bash
   > npm install -g @mermaid-js/mermaid-cli
   > ```

2. **Write the raw Mermaid code** (without the markdown fences) to a temp file:

   ```bash
   MERMAID_TMP=$(mktemp /tmp/mermaid_XXXXXX.mmd)
   cat > "$MERMAID_TMP" << 'MERMAID_EOF'
   <paste mermaid code here>
   MERMAID_EOF
   ```

3. **Run mmdc to validate** — render to SVG in a temp location and check the exit code:

   ```bash
   mmdc -i "$MERMAID_TMP" -o /tmp/mermaid_validate_out.svg -q 2>&1
   ```

   - `-i` — input .mmd file
   - `-o` — output file (SVG by default; we just need it to attempt rendering)
   - `-q` — quiet mode (suppresses noisy log output, only shows errors)

4. **Interpret the result:**
   - **Exit code 0**: Diagram is valid. Clean up temp files and proceed.
   - **Non-zero exit code**: There's a syntax error. Read the error output, fix the Mermaid code, and re-validate. Repeat until it passes.

5. **Clean up** temp files after validation:

   ```bash
   rm -f "$MERMAID_TMP" /tmp/mermaid_validate_out.svg
   ```

### Key mmdc options (for reference)

| Flag | Purpose |
| ---- | ------- |
| `-i <file>` | Input .mmd file (required) |
| `-o <file>` | Output file (.svg, .png, .pdf) |
| `-t <theme>` | Theme: default, forest, dark, neutral |
| `-b <color>` | Background color (e.g. transparent, #F0F0F0) |
| `-w <width>` | Page width in pixels (default: 800) |
| `-H <height>` | Page height in pixels (default: 600) |
| `-q` | Quiet mode — suppress logs, show only errors |

## Output Specification

Generated Mermaid code should:

1. Be wrapped in ```mermaid code blocks
2. Have correct syntax that renders directly
3. Have clear structure with proper line breaks and indentation
4. Use semantic node naming
5. Include styling when needed to improve visual appearance

## Example Output

```mermaid
flowchart TD
    A[Start] --> B{Condition}
    B -->|Yes| C[Execute]
    B -->|No| D[End]
    C --> D
```

---

User requirements: $ARGUMENTS
