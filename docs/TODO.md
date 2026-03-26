[ ] file removal (including scratch): options
[ ] thread handling rewamp - should we include full thread all the time? mention mode vs. all
[x] user directory inclusions (slack id - userid mapping)
[ ] repo sync error handling: [sync-repos] Repo sync complete while docker couldn't
[ ] autopull repo ? when ? 
[ ] qmd cache / database on persistent volume in docker
[ ] checkmark emoji config
[ ] sort out git repos mess: sync-repos.ts, 
[ ] git ssh priv key / JIRA token hide in docker? docker secrets? envx ?
[ ] set atlassion creds for readonly / jirawrite users to allow them to write to JIRA with own creds?
[ ] inject channel name to claude?
[ ] persistent mode-> do we need it? how it handles long threads? test with new features (eg. permissions)
[ ] Persistent mode: avoid reinjecting full Slack thread on every turn when the same Claude process is already carrying context
[ ] I'm on the main branch in the copilot-spike repo.
[x] Bug: CopilotBrain cannot see content of forwarded Slack messages attached to a user's message (only sees attached files/images, not forwarded message text)
[ ] more generalized permissioning somehow ? eg. jiraWrite , git maybe somekind of plugin structure?
[ ] Voice UI: parse `assistant` events with tool_result content to show Bash command output as sub-detail (like Claude CLI does)
[ ] expose new TTS SST to capabilities to all channales (e.g receive voice from slack / generate )
