# career-ops daily agent

Runs every morning on your PC, on top of the career-ops repo next to this folder:

| Step | What happens | Cost |
|---|---|---|
| 1. Scan | `node scan.mjs` checks the company career boards in `portals.yml` | free |
| 2. Screen | One short Claude call ranks new postings on title + location vs your profile | small |
| 3. Evaluate | The top matches (max `MAX_EVALS_PER_RUN`) go through career-ops' full evaluation: A-G report, 1-5 score, **tailored CV PDF** | main cost |
| 4. Cover letter | For every score >= `MIN_SCORE`: a tailored letter PDF (fact-checked against `cv.md`) plus a `.md` copy to paste | small |
| 5. Log | Rebuilds `job-log.xlsx`: Applications, Daily runs, Screening log | free |
| 6. Notify | WhatsApp summary with the top matches and links | free |

**It never submits applications or messages employers.** You open the links, check the CV and letter, and apply yourself.

Where things end up:
- Tailored CVs: `career-ops\output\cv-candidate-*.pdf`
- Cover letters: `career-ops\output\cover-letters\`
- Reports: `career-ops\reports\`
- Tracker: `career-ops\data\applications.md` (career-ops' own) and `automation\job-log.xlsx`
- Logs: `automation\logs\`

## One-time setup

### 1. Finish career-ops onboarding (required)
Save your resume in the career-ops folder as `cv.md` (Markdown). In VS Code, open a terminal in `<path-to>\career-ops`, run `claude`, and say:

> Help me complete my career-ops onboarding. My CV is already in cv.md. Target roles: [your roles]. Location: [your locations]. Salary: [your range]. Experience: 4+ years. Spend tier: economy. Use only my actual qualifications.

Then ask it to **"set auto_pdf_score_threshold to 4.0 in config/profile.yml"** so CVs are only generated for real matches.

Then paste one job URL to check the scores make sense before automating.

### 2. Install the PDF browser (if `node doctor.mjs` says it's missing)
```powershell
cd <path-to>\career-ops
npx playwright install chromium
```

### 3. WhatsApp (CallMeBot, free)
1. Follow https://www.callmebot.com/blog/free-api-whatsapp-messages/ (add their number to your contacts and send them the activation message from WhatsApp).
2. You'll get an API key by WhatsApp.

(Prefer Twilio? Set `WHATSAPP_PROVIDER=twilio` and the `TWILIO_*` values instead.)

### 4. Configure
```powershell
cd <path-to>\automation
copy .env.example .env
notepad .env        # set CALLMEBOT_PHONE and CALLMEBOT_APIKEY
```

### 5. Test, in this order
```powershell
node daily-agent.mjs --test-whatsapp   # you should get a WhatsApp message
node daily-agent.mjs --dry-run         # scan + screen + spreadsheet + message, no evaluations
node daily-agent.mjs                   # full run (takes a while)
```

### 6. Schedule it
From a normal (not admin) PowerShell window:
```powershell
powershell -ExecutionPolicy Bypass -File install-task.ps1 -Time 07:45
# or Mon-Fri only:  ... install-task.ps1 -Time 07:45 -Weekdays
# test now:         Start-ScheduledTask -TaskName "career-ops daily agent"
# remove:           ... install-task.ps1 -Uninstall
```
The PC must be on and you must be logged in. If it was asleep at 7:45, the run starts when it wakes.

## Tuning

- **Too many / too few evaluations**: `MAX_EVALS_PER_RUN` in `.env`. Good matches over the limit roll over to the next day (for up to 14 days).
- **Hitting Claude usage limits**: lower `MAX_EVALS_PER_RUN` / `BATCH_PARALLEL`, or set `BATCH_MODE=match` (cheaper, no CV PDF). Paused jobs resume automatically next run.
- **Wrong kinds of jobs**: fix your targeting in career-ops (`config/profile.yml`, `portals.yml` keywords, `modes/_profile.md`), not here.
- **Spreadsheet was open in Excel**: the run saves a "locked copy" next to it. Close Excel before the scheduled time to keep one file.
- **Rebuild the spreadsheet any time**: `node daily-agent.mjs --excel-only`

## About the cover letters
career-ops' own `/career-ops cover` asks you four questions first (why this company, what you'd solve, your approach, tone). It can't run unattended, so this agent writes **auto-drafts** from your CV and the evaluation report instead, and they still go through career-ops' fact checker. If a job really matters to you, run `/career-ops cover <company>` in Claude Code for the fuller interactive version.
