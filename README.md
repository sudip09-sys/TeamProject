# NextStep — Team Study Planner

**Team: Eric, Abinash, Sondor, and Sudip (team lead).**

Repository: **TeamProject** — application and preparation for the midterm presentation.

A shared planner with individual sign-in, task assignments, deadlines, progress, and an activity feed.

## Live application

https://nextstep-team-production.up.railway.app/

For first-time access, choose **Create account**, select your own member name, choose your password, and enter the private team invite code. Sudip can retrieve that code from Railway → NextStep Team Planner → nextstep-team → Variables → TEAM_INVITE_CODE. Share it privately within the team. No member passwords have been created in advance.

## Run on your computer

1. Install **Node.js 24 LTS**. Check with `node --version`.
2. Extract the ZIP, open this folder in VS Code, and open its terminal.
3. Run `npm start`. No external packages need installing.
4. Visit **http://127.0.0.1:4175**.
5. Choose **Create account**, select your own name, choose a password of at least 10 characters, and enter the local development invite code: **nextstep-local-team**.
6. Sign out and sign back in. Each member should create their own account and choose their own password.

Keep the terminal running. Stop with **Ctrl+C**. Use another browser or private window to test a second account independently. All members must connect to the same server; separate copies have separate databases.

Do not use Live Server for this version: sign-in and shared tasks require the Node backend. The previous device-only prototype remains separate.

## Private invite code

Copy `.env.example` to `.env`, set your own `TEAM_INVITE_CODE`, and start with:

```sh
node --env-file=.env server.mjs
```

Do not commit `.env` or share passwords. The code is used only for first-time registration. Each of the four names can be registered once; existing members sign in with their passwords.

## Features

- Accounts for Eric, Abinash, Sondor, and Sudip.
- Passwords hashed using scrypt with individual salts.
- HttpOnly session cookies and server-side sessions that expire after seven days.
- Shared SQLite database created at `data/nextstep.sqlite`.
- Add, edit, assign, complete, reopen, delete, and restore tasks.
- All tasks, My tasks, Due today, Upcoming, and Completed views.
- Search and subject filters, optional deadlines, and overdue indicators.
- Team workload cards and recent activity.
- Automatic refresh every 12 seconds while active, plus manual Refresh.
- Task-version checks reject stale edits instead of overwriting another member's work.
- Responsive layout.

All four members have equal workspace permissions and can edit any task. My tasks shows unfinished tasks assigned to the signed-in member. Registration status is not online presence. App activity is not evidence of code contributions. Password recovery and account management are not included in this first version.

## Proposed team responsibilities

Agree on these together; they are planned assignments rather than completed contribution claims.

| Member | Proposed responsibility |
|---|---|
| Eric | Forms, task interface, accessibility |
| Abinash | CSS, responsive layout, visual polish |
| Sondor | Filters, task interactions, testing |
| Sudip | Coordination, backend integration, deployment |

## Source guide

- `index.html`: sign-in and task board.
- `styles.css`: design and responsive layout.
- `app.js`: frontend API calls, state, rendering, and controls.
- `server.mjs`: HTTP server, authentication, validation, and database.
- `team.html`: team overview and proposed responsibilities.
- `tests/`: automated backend checks; run **npm test**.
- `data/`: runtime database; ignored and not included in the source ZIP.
- `Dockerfile`: container setup for backend hosting.

## Hosting

The ZIP runs locally; it is not a public deployment. GitHub Pages cannot run this backend. Deploy **one Node.js 24 process** with a **persistent disk**, using `npm start` or the Dockerfile.

Configure:

- `NODE_ENV=production`
- `HOST=0.0.0.0`
- `PORT` supplied by your host
- `APP_ORIGIN` as your exact public HTTPS origin, without a trailing slash
- `TEAM_INVITE_CODE` as a private random code of at least 16 characters
- `DATABASE_PATH` as a SQLite file on a persistent disk

Production rejects the development invite code and requires HTTPS. When using Docker, mount persistent storage at `/app/data`. Do not run multiple replicas with separate database files. The `/health` route reports server health.

The Docker entrypoint prepares the mounted data directory, then starts the server as the unprivileged `node` user. For Railway, create one service from this repository, attach a 500 MB volume at `/app/data`, generate its public domain, and set `APP_ORIGIN` to that HTTPS origin before deployment. Use `/health` for the health check and keep a single replica.

Only allowlisted UI files are public. Database, environment, test, and server-source files are not served. Mutations check the request origin and JSON format; authentication is rate-limited. Back up using a SQLite-aware backup while running, or stop the server before copying database files.

## Demo sequence

1. Sign in and assign a task to another member.
2. Sign in as that member in a separate browser session; refresh the board.
3. Complete the task and show the team activity feed.
4. Demonstrate filters, editing, delete/undo, and mobile layout.
5. Explain the architecture and the next improvements each member will build.

