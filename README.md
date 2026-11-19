# AI Job Hunt Agent (Claude + Google Drive)

A job-search agent that runs in Claude's cloud twice a day on weekdays, even with your computer off. Each run:

1. Searches fresh US job postings (LinkedIn, Indeed, Glassdoor, ZipRecruiter, Dice, Wellfound, Built In, Jobright, MyVisaJobs, Greenhouse/Lever/Ashby/Workday, plus career sites of ~50 large H-1B sponsors).
2. Keeps only postings under 14 days old and still open. If fewer than 3 good matches turn up, it widens the search to 28 days.
3. Scores each job 1-5 against your resume (role fit, skills, domain, sponsorship, location, pay) and skips dealbreakers such as "no sponsorship".
4. For every job scoring 4.0 or higher (max 5 per run), writes an ATS-tailored one-page LaTeX resume PDF. It pulls keywords from the full job description, reworks only the Summary, Experience bullets, Projects and Skills, and never invents anything.
5. Logs every job to a Google Sheet: company, website, role, posted date, score, sponsorship, full job description, ATS keywords added, and match % before -> after.
6. Writes a timestamped log file (`jobsearch_MMDDYYYY.log`, from `START AT ...` to `END AT ...`) and sends a phone push notification with the top matches.

It **never applies or contacts anyone**. You review and submit.

## What you need

- A Claude plan that includes **scheduled tasks** and connectors.
- **Google Drive** and **Google Sheets** connectors connected in Claude (Settings -> Connectors). A separate Google account just for storage works fine.
- Your resume as a **one-page LaTeX file** (e.g. from Overleaf). `templates/resume_template.tex` is a starter.

## Folder contents

| Path | What it is |
|---|---|
| `prompts/job-agent-prompt.md` | The agent's full instructions (the main "code"). Fill the `{{...}}` placeholders. |
| `prompts/evening-starter-prompt.md` | Tiny task that starts the main agent in the evening. |
| `skills/job-health/SKILL.md` | `/job-health` command: status, last runs, errors, jobs waiting. |
| `skills/force-run/SKILL.md` | `/force-run` command: start a full run now. |
| `templates/tracker_Jobs_tab.csv`, `tracker_Runs_tab.csv` | Header rows for the Google Sheet tracker. |
| `templates/resume_template.tex` | One-page LaTeX resume layout the agent expects. |
| `optional-laptop-version/` | Older alternative that runs on a Windows PC with the open-source career-ops project (Node.js, Task Scheduler, Excel log, WhatsApp). Not needed for the cloud version. |

## Setup (about 20 minutes)

1. **Google Drive:** create `My Drive/claude-agent-job-hunt/` with subfolders `resume/` and `logs/`. Copy each folder's ID from its URL (the part after `/folders/`).
2. **Tracker:** create a Google Sheet named `Job Search Tracker` inside `claude-agent-job-hunt/`. Rename the first tab `Jobs` and paste the header row from `templates/tracker_Jobs_tab.csv`. Add a tab `Runs` with the header row from `templates/tracker_Runs_tab.csv`. Copy the sheet ID from its URL (between `/d/` and `/edit`).
3. **Prompt:** open `prompts/job-agent-prompt.md` and fill every `{{...}}`: your name, profile, work authorization, salary, target titles, dealbreakers, the 4 Drive/Sheet IDs, and paste your full LaTeX resume at the bottom. Remove the H-1B wording if you don't need sponsorship.
4. **Morning task:** in a Claude chat (with the Drive + Sheets connectors on), ask Claude to *"create a scheduled task named 'Job agent - morning', weekdays at 7:14 AM <your time zone>, with push notifications, using this prompt"* and paste the filled prompt. Note the task ID it returns (`trig_...`).
5. **Evening task:** same, named 'Job agent - evening', weekdays at 4:44 PM, using `prompts/evening-starter-prompt.md` with `{{MORNING_TASK_ID}}` filled in.
6. **Commands:** fill the IDs in both `skills/*/SKILL.md` files and ask Claude to save them as skills (or add them through Claude's skills settings).
7. **Test:** type `/force-run`, wait for the notification, then `/job-health`.

## Why these times

Recruiters review applications first thing in the morning, and new postings cluster around late morning and late afternoon. The 7:14 AM run lets you apply before 10 AM; the 4:44 PM run catches the day's postings so you can apply the next morning. Runs sit a few minutes off the hour because tasks scheduled exactly on the hour can be delayed.

## Cost controls built in

Weekday-only runs; at most 16 searches, 12 full job reads and 5 resumes per run; each posting is fetched once and reused; jobs already in the tracker are skipped; PDFs are uploaded as file references rather than encoded text.

## Honest limits

- LinkedIn, Indeed and some big-company career sites block automated reading. The agent uses them to find jobs, then confirms each one on a page it can read (usually the company's own job page).
- Posted dates are sometimes not shown; the agent marks them "unknown".
- Scores are AI judgment, not a hiring probability. Always read the tailored resume before you send it.

## License

Add a license of your choice before publishing (MIT is common). The optional laptop version builds on career-ops (https://github.com/career-ops-hq/career-ops, MIT).
