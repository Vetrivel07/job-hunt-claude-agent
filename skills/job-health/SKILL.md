---
name: job-health
description: Health check for the job-search agent: last runs, status, jobs found, errors, next scheduled runs. Use when the user types /job-health or asks how the job agent is doing.
---

# Job agent health check

Read-only. Never change anything. Keep the answer short.

## IDs (fill these in)
- Morning scheduled task (the real job): `{{MORNING_TASK_ID}}`
- Evening scheduled task (starts the morning one): `{{EVENING_TASK_ID}}`
- Tracker Google Sheet: `{{TRACKER_SHEET_ID}}` (tabs `Jobs`, `Runs`)
- Logs folder in Drive: `{{LOGS_FOLDER_ID}}`

## Steps
1. Load tools with ToolSearch if needed: `mcp__claude-code-remote__list_triggers`, Google Sheets `get_values`, Google Drive `search_files` and `read_file_content`.
2. `list_triggers`. For both task IDs report: enabled, last run (status, start, finish, local time), next run, any suspension. A FAILED last run, or a run started over 90 minutes ago with no finish, is a problem.
3. `get_values` on `Runs!A1:M500`: show the last 3 rows (started, ended, type, status, evaluated, matches >= 4.0, resumes, window, errors).
4. `get_values` on `Jobs!A1:P2000`: count today's rows, today's rows with score >= 4.0, and rows with Status `New` and score >= 4.0 (waiting to apply). List up to 5: score | role | company | apply link | resume link.
5. In the Logs folder find the newest `jobsearch_*.log`; confirm the first line starts `START AT` and the last line starts `END AT`; show its last 10 lines.
6. Reply: Overall (HEALTHY / WARNING / DOWN + reason), Last run, Next runs, Waiting for you, Problems, links to the tracker and Drive folder.
