# NextStep — Team workspace

Eric · Abinash · Sondor · Sudip

Live app: https://nextstep-team-production.up.railway.app/

NextStep brings a student team's tasks, milestones, discussions, study sessions, and focus time together. Each member has a separate account and shares one online workspace.

## Start locally

Use Node.js 24, extract the source ZIP, open this folder in VS Code, and run:

```sh
npm start
```

Open http://127.0.0.1:4175. Create your account with your own member name and a password of 10–128 characters. The local development invitation is `nextstep-local-team`. It does not work on the hosted app. No package installation is needed.

For a custom local invitation, set TEAM_INVITE_CODE in your environment, or create .env from .env.example and run `node --env-file=.env server.mjs`. Use the Node server, not Live Server.

## A complete team workflow

1. Create a milestone such as Midterm Presentation, with a target date.
2. Add tasks, choose priorities, assignees, reviewers, and deadlines, and attach work links.
3. Choose prerequisite tasks. A blocked task stays in To do until those prerequisites are Done. Cycles are rejected.
4. The assignee, task creator, or Sudip moves the task to In progress. Status menus work on phones and keyboards; desktop cards also support drag and drop.
5. Add comments and links to show the work. With an assignee and a separate reviewer selected, submit it for Review.
6. Only the selected reviewer can approve it as Done or request changes by returning it to In progress. Without a reviewer, a task can be completed directly.
7. Assignment, comment, review, and study-session notifications appear in the relevant registered members' inboxes. Updates flow through an authenticated Server-Sent Events connection, with periodic refresh as a fallback.
8. Review milestone completion, overdue work, workload, focus time, and recent contribution history on Overview.

A prerequisite cannot be deleted while another task depends on it. Move dependent tasks to To do before reopening a completed prerequisite. Task and milestone edits carry version numbers, so stale edits are rejected rather than overwriting somebody else's work. Close and reopen a changed task before resubmitting an edit.

All members can create tasks, edit task details, comment, and create milestones. The server enforces task status and reviewer permissions. Resource authors or Sudip can delete their resources; session organizers or Sudip can cancel sessions. Shared-workspace activity is not a measure of code contributions; use GitHub for those.

## Calendar, sessions, and resources

Calendar shows task deadlines, milestone targets, and study sessions. Schedule a future session in your device's local time zone; the server stores its UTC time. Other members see it in their own time zone. RSVP Going, Maybe, or Can't attend. Copy invitation copies the title, time, agenda, and app link for your group chat. It does not send a message automatically.

The resource shelf stores shared HTTP/HTTPS links. Each task also supports up to ten labeled work links. Files are not uploaded to the server.

## Study Break

- Focus timer: choose 1–180 minutes, pause/resume/reset, switch to a break, and explicitly save a completed focus session. The timer uses a wall-clock deadline to catch up after a background tab is throttled. Closing/reloading the page ends the local timer. Focus totals are self-reported, not verified attendance.
- Background audio: synthesized rain, cafe hum, or white noise with a volume slider. Nothing plays automatically. You can select your own local audio file; it is never uploaded. Mobile browsers may suspend audio or timers when the phone locks.
- Memory garden: match six pairs. Best move count is saved per member in this browser.
- Typing sprint: a 60-second passage, accuracy and correct-character WPM. Paste is disabled during the challenge. Finishing the passage early also ends the round.
- Study quiz: six questions about the project's workflow and technology, with immediate explanations and a round score.

Games run locally and have no competitive shared leaderboard. The timer, games, and selected music file are not synced to teammates. Completed focus totals are shared. All games still work if browser storage is unavailable; personal bests then last only for the page session.

## Accounts and invitations

The four member slots are fixed: Eric, Abinash, Sondor, and Sudip. An invitation lets an unregistered member claim their slot. Registered members sign in using their own password and do not need an invitation again.

The initial live invitation is configured in Railway's TEAM_INVITE_CODE variable. Sudip can replace it in Account & data → Team invitation. A replacement takes effect immediately and is stored as a hash in the database; the old Railway variable is no longer the active invitation after a replacement. A replacement is displayed once to Sudip, who can copy it privately. Existing accounts and sessions remain active. Do not publish invitation or recovery codes in the repository.

In Account & data, a member can change their password with their current password. Other sign-in sessions are revoked. Generate a private recovery code after confirming the current password and store it safely. It is hashed server-side, shown once, and can be used once from Recover my account on the sign-in page. Generate a new one after recovery. There is no email password reset or admin impersonation.

Passwords use scrypt with a random salt. Sessions use random tokens, hashed server-side, and HttpOnly SameSite cookies (Secure in production). Mutation requests require the configured origin. Private server and database files are never served. Authenticated live streams carry change signals, not shared data or credentials, and expire when their session is revoked.

## Data, migrations, and backup

Production uses `/app/data/nextstep.sqlite` on Railway's persistent volume. Never replace or remove that volume during a source deployment. Versioned migrations preserve the original accounts, sessions, task IDs, versions, and completion state. Older completed tasks become Done; others become To do with Medium priority.

At startup, the server creates a consistent SQLite snapshot in the database's `backups` folder (at most one per date/schema version) before applying a migration. It retains the latest seven automatically named snapshots. These share the database volume: download a backup elsewhere for protection against loss of the whole volume. No scheduled offsite backup is configured.

Create a manual consistent backup while the server is running:

```sh
npm run backup
# Or select a NEW destination:
node scripts/backup.mjs path/to/new-backup.sqlite
```

DATABASE_PATH selects the source database when set. Backups contain private account hashes and session data; keep them private. The script checks SQLite integrity and refuses to overwrite an existing file.

To restore, stop the application, restore into a NEW database file, and point DATABASE_PATH to it before restarting:

```sh
node scripts/restore.mjs path/to/backup.sqlite path/to/restored.sqlite
```

The restore command validates the backup and never overwrites a running or existing database. Keep the old file until you have verified the restored app. For Railway, run these maintenance commands in the service/container with the mounted volume; do not run a restore against the active database.

Account & data → Download workspace data exports shared records as JSON without passwords or sign-in tokens. This is a readable workspace export, not a full database backup or an import mechanism.

## Team coding workflow

Create an issue using the repository template: describe the user need, an owner and reviewer, and observable acceptance criteria. Each member creates a feature branch, implements a small change, runs the relevant checks, and opens a pull request. Another member reviews it. Use the PR template to record validation and a demo. Merge after checks pass, then verify the Railway deployment. The repository includes CI on pushes and pull requests; branch protection and mandatory review rules are not configured automatically.

Suggested areas to learn and improve:

- Eric: forms, task details, accessible status controls, and discussion UI.
- Abinash: visual design, calendar, phone layouts, and Study Break appearance.
- Sondor: timer/game interactions, filters, and testing task workflows.
- Sudip: API, migrations, permissions, integration, and deployment.

These are suggested responsibilities. Each member should understand and commit their own changes and explain them during the demonstration.

## Tests and deployment

```sh
npm test
```

Tests cover the original shared-task behavior plus reviews, dependencies, notifications, ownership, account recovery, invite rotation, live events, and migration of the old schema. Disposable test databases are separate from production.

Railway builds the included Dockerfile with Node.js 24. Required production environment variables: NODE_ENV=production, APP_ORIGIN set to the exact HTTPS origin, TEAM_INVITE_CODE with at least 16 private characters, and DATABASE_PATH on the attached persistent volume. HOST=0.0.0.0 and PORT=4175 are configured by the image. Health check: `/health`.

Main files:

- `index.html`: accessible workspace and dialogs.
- `styles.css`: responsive layout and visual system.
- `app.js`: authentication, workspace rendering, API, live sync, and forms.
- `break.js`: focus timer, sound synthesis, local music, memory, typing, and quiz.
- `server.mjs`: HTTP server, sessions, origin checks, and static allowlist.
- `workflow.mjs`: migrations, task rules, shared features, accounts, and live event streams.
- `tests/`: server integration tests; `scripts/`: backup and restore tools.

The source ZIP excludes databases, accounts, session data, and private environment files.
