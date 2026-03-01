# Slack mrkdwn Syntax Reference

Slack uses its own markup language called **mrkdwn** — similar to Markdown but with key differences.

## Text Formatting

| Style         | Syntax       | Notes                              |
| ------------- | ------------ | ---------------------------------- |
| Bold          | `*text*`     | Single asterisks (not `**`)        |
| Italic        | `_text_`     | Underscores only                   |
| Strikethrough | `~text~`     | Single tildes                      |
| Inline code   | `` `code` `` |                                    |
| Code block    | ` ```code``` `  | All formatting inside is ignored |
| Blockquote    | `>text`      | Prefix each line with `>`          |
| Line break    | `\n`         | Literal newline in text strings    |

## Links

```
<https://example.com|display text>     # Link with label
<https://example.com>                  # Auto-displayed URL
<mailto:bob@example.com|Email Bob>     # Email link
```

Plain URLs (`https://...` and `www.…`) are auto-linked.

## Mentions & References

```
<@U012AB3CD>              # Mention a user (by user ID)
<#C123ABC456>             # Link a channel (by channel ID)
<!subteam^SAZ94GDB8>      # Mention a user group
<!here>                   # Notify active channel members
<!channel>                # Notify all channel members
<!everyone>               # Notify all workspace members (non-guest)
```

## Date Formatting

Syntax: `<!date^UNIX_TIMESTAMP^token_string^optional_link|fallback>`

Tokens:

| Token            | Example output             |
| ---------------- | -------------------------- |
| `{date_num}`     | 2014-02-18                 |
| `{date}`         | February 18th, 2014        |
| `{date_short}`   | Feb 18, 2014               |
| `{date_long}`    | Tuesday, February 18th, 2014 |
| `{time}`         | 6:39 AM / 06:39            |
| `{time_secs}`    | 6:39:42 AM / 06:39:42      |
| `{ago}`          | 3 minutes ago              |

`_pretty` variants (`{date_pretty}`, `{date_short_pretty}`, `{date_long_pretty}`) substitute "yesterday", "today", or "tomorrow" when applicable.

## Lists

No dedicated list syntax. Use manual bullet characters with line breaks:

```
- Item one\n- Item two\n- Item three
```

## Emoji

Use colon syntax: `:smile:`, `:thumbsup:`, `:rocket:`. Unicode emoji are also supported and auto-converted to colon format in API responses.

## Character Escaping

These three characters have special meaning and must be escaped when used literally:

| Character | Escape as |
| --------- | --------- |
| `&`       | `&amp;`   |
| `<`       | `&lt;`    |
| `>`       | `&gt;`    |

## Key Differences from Standard Markdown

| Feature    | Markdown           | Slack mrkdwn                |
| ---------- | ------------------ | --------------------------- |
| Bold       | `**text**`         | `*text*`                    |
| Italic     | `*text*`           | `_text_`                    |
| Links      | `[text](url)`      | `<url\|text>`               |
| Headers    | `# Heading`        | Not supported               |
| Images     | `![alt](url)`      | Not supported (use blocks)  |
| Lists      | `- item` / `1. item` | No syntax (manual only)   |

## Disabling mrkdwn

- **Block Kit text objects:** set `"type": "plain_text"`
- **Top-level messages:** set `"mrkdwn": false`
- **Attachments:** omit fields from `mrkdwn_in` array
