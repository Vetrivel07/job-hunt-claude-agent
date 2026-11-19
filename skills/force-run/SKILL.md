---
name: force-run
description: Start the job-search agent immediately for a full run (search, score, tailored resumes, tracker, log). Use when the user types /force-run or asks to run the job agent now.
---

# Force a full job-agent run now

The real job is the scheduled task `{{MORNING_TASK_ID}}`. A force run fires it immediately.

## Steps
1. Load `mcp__claude-code-remote__list_triggers` and `mcp__claude-code-remote__fire_trigger` with ToolSearch if needed.
2. If the task's last run started under 60 minutes ago and has no finish time, a run is probably still going: say so and ask before starting another.
3. Call `fire_trigger` with `trigger_id` = `{{MORNING_TASK_ID}}` and `text` = `RUN TYPE: force-run` (append any extra instructions the user gave for this run on a new line).
4. Reply in 2-3 lines: started at <local time>; usually 10-40 minutes; a push notification arrives when done; results land in the tracker and the Drive folder; run /job-health later.
