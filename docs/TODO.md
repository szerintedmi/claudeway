[x] file removal (including scratch): options — `tempMaxAgeDays` config added (default 90 days); temp/scratch/req dirs consolidated into one per-session temp dir (docs/plans/2026-07-04-temp-dir-consolidation.md)
[x] thread handling rewamp - should we include full thread all the time? mention mode vs. all
[x] user directory inclusions (slack id - userid mapping)
[ ] repo sync error handling: [sync-repos] Repo sync complete while docker couldn't
[x] autopull repo ? when ? 
[ ] qmd cache / database on persistent volume in docker
[ ] checkmark emoji config
[x] sort out git repos mess: sync-repos.ts, 
[x] git ssh priv key / JIRA token hide in docker? docker secrets? envx ? → solved by env allowlist (permissions config)
[x] Whitelist env vars for Claude subprocess instead of inheriting all of process.env and stripping secrets → done: unified permissions model with env + permissions config
[x] set atlassion creds for readonly / jirawrite users to allow them to write to JIRA with own creds?
[ ] inject channel name to claude?
[ ] persistent mode-> do we need it? how it handles long threads? test with new features (eg. permissions)
[x] Persistent mode: avoid reinjecting full Slack thread on every turn when the same Claude process is already carrying context
[x] Bug:  cannot see content of forwarded Slack messages attached to a user's message (only sees attached files/images, not forwarded message text)
[x] more generalized permissioning somehow ? eg. jiraWrite , git maybe somekind of plugin structure? → done: unified permissions model, custom permissions (e.g. langfuse) are env-var-only
[ ] Docker: make Jira MCP work (Atlassian plugin uses OAuth — need auth cache mount or switch to self-hosted mcp-atlassian with API token in mcp.json)
[ ] Docker: end-to-end test with env allowlist, voice, MCP, and all current features
[ ] Voice UI: parse `assistant` events with tool_result content to show Bash command output as sub-detail (like Claude CLI does)
[ ] expose new TTS SST to capabilities to all channales (e.g receive voice from slack / generate )
[ ] Streaming STT (OpenAI?)
