# AI Proctor Browser

An Electron-based desktop examination platform with exam-session lockdown, camera-based monitoring signals, real-time event reporting, and a Node.js backend for exam and student management.

> **Project status:** Active development / early-stage. This repository is a work in progress, not a certified examination-security product. Detection signals can be wrong and must be reviewed by a human.

## What it does

AI Proctor Browser brings the candidate exam experience and the educator's monitoring tools into one desktop application.

### Candidate experience
- Sign-in and exam instructions before entering an exam.
- An exam room with a countdown timer, question navigation, answer selection, and progress tracking.
- Camera and microphone access for the monitoring signals implemented in the exam room.
- Face-presence and multiple-face detection using the bundled face-api.js library and local model files.
- Client-side monitoring signals for events such as no face, multiple faces, audio level, and gaze-away conditions.
- Exam submission and a post-exam report flow.

### Educator experience
- Teacher registration and sign-in.
- Teacher dashboard and exam-management pages.
- Create and edit exams.
- Student records, exam results, and post-exam reporting.
- Live proctor dashboard and monitoring views.

### Desktop and backend
- Electron main process and preload bridge for communication between the desktop shell and renderer pages.
- Kiosk-style fullscreen behaviour and exam-time shortcut restrictions.
- Express API with authentication, student, teacher, exam, and event routes.
- PostgreSQL persistence.
- Socket.IO events for live exam and proctoring updates.
- Optional Redis support for caching and multi-instance Socket.IO scaling.
- Security middleware including Helmet, CORS checks, request limits, and rate limiting.

Monitoring events are **signals for review**, not proof of misconduct. The desktop restrictions are best-effort application controls; they do not replace operating-system device management, physical supervision, or a properly secured exam environment.

## Screens and interface

The application currently includes the following interface pages:

| Area | Page |
| --- | --- |
| Candidate | [Login](pages/login.html), [Instructions](pages/instructions.html), [Exam room](pages/exam-room.html), [Post-exam report](pages/post-exam-report.html) |
| Educator | [Teacher registration](pages/teacher-register.html), [Teacher dashboard](pages/teacher-dashboard.html), [Create exam](pages/create-exam.html), [Edit exam](pages/edit-exam.html) |
| Management | [Exam management](pages/exam-management.html), [Student records](pages/student-records.html), [Exam results](pages/exam-results.html) |
| Monitoring | [Proctor dashboard](pages/proctor-dashboard.html), [Live monitoring](pages/live-monitoring.html) |

### Screenshots and demo

No verified application screenshots or demo video are included in the repository yet. Follow the [screenshot and demo capture checklist](docs/SCREENSHOTS.md), then add captures from a running build under `docs/screenshots/` and link them here. Use synthetic/demo accounts and data only; never commit real student records, webcam frames, or evidence images.

Suggested captures:

1. Teacher dashboard with sample exam data.
2. Exam creation or management screen.
3. Candidate exam room with a synthetic test exam.
4. Proctor live-monitoring screen with test sessions.
5. Post-exam report using synthetic data.

A short demo should show the full workflow using test accounts, with personal information and credentials hidden.

## Architecture

```text
AI-Proctor-Browser/
├── main.js                    # Electron main process; starts the backend and creates the window
├── preload.js                 # Context bridge and approved renderer IPC methods
├── package.json               # Electron app scripts and dependencies
├── pages/
│   ├── *.html                 # Candidate, teacher, exam, report, and monitoring screens
│   ├── shared.css             # Shared interface styles
│   ├── main.js                # Renderer-side page logic
│   ├── lib/face-api.min.js    # Local face-api.js runtime
│   └── models/                # Local face-detection model weights/manifests
└── backend/
    ├── index.js               # Express and Socket.IO server entry point
    ├── config/                # Environment configuration and CORS policy
    ├── db/                    # PostgreSQL pool/schema and optional Redis client
    ├── middleware/            # Security, rate-limit, and error middleware
    ├── routes/                # Authentication, student, teacher, and exam APIs
    ├── sockets/               # Real-time proctoring/event handlers
    ├── helpers/               # Shared backend utilities
    └── .env.example           # Backend environment template
```

### Event flow

1. The Electron main process opens the candidate or educator interface.
2. When an exam room is loaded, the main process enables its kiosk-style controls.
3. The renderer obtains camera/microphone access and runs the local monitoring logic available in the exam room.
4. The preload bridge sends approved events to the Electron main process.
5. The main process forwards exam events and violation metadata to the backend over Socket.IO.
6. The backend exposes REST endpoints and Socket.IO handlers, persists application data in PostgreSQL, and can use Redis when enabled.

## Technology

- **Desktop:** Electron
- **Backend:** Node.js, Express
- **Database:** PostgreSQL
- **Live updates:** Socket.IO
- **Optional cache/scaling:** Redis and the Socket.IO Redis adapter
- **Monitoring in the renderer:** face-api.js, browser media APIs, HTML, CSS, and JavaScript

## Requirements

- Node.js 22 or newer (the CI workflow uses Node.js 22).
- npm.
- PostgreSQL, with a database and user created for this application.
- Redis is optional. The supplied environment template disables it by default.
- A camera and microphone for the candidate monitoring features.
- A desktop operating system supported by the installed Electron release.

The current PostgreSQL pool maps `localhost`, `127.0.0.1`, and an unset `DB_HOST` to the Unix socket directory `/tmp`. This is suitable for common local macOS/Linux PostgreSQL setups where that socket exists. Windows or TCP-only deployments may need a small adjustment in `backend/db/pool.js` to use the configured host directly.

## Installation and setup

### 1. Clone the repository

```bash
git clone https://github.com/AjayGupta2004/AI-Proctor-Browser.git
cd AI-Proctor-Browser
```

### 2. Install dependencies

```bash
npm install
npm ci --prefix backend
```

The first command installs the Electron application dependencies. The second installs the backend dependencies from its lockfile.

### 3. Create the PostgreSQL database

For example, using the PostgreSQL command-line tools:

```sql
CREATE USER proctor_user WITH PASSWORD 'replace-with-a-strong-password';
CREATE DATABASE proctordb OWNER proctor_user;
```

The backend creates/updates its application tables when it starts. Make sure the PostgreSQL server is running and the database user can connect to `proctordb`.

### 4. Configure the backend

Copy the example environment file:

```bash
cp backend/.env.example backend/.env
```

Edit `backend/.env` and set at least the database values:

```dotenv
DB_HOST=localhost
DB_PORT=5432
DB_NAME=proctordb
DB_USER=proctor_user
DB_PASSWORD=replace-with-a-strong-password
DB_SSL=false

PROCTOR_PORT=4000
CORS_ORIGINS=http://localhost:4000,http://127.0.0.1:4000

REDIS_ENABLED=false
REDIS_URL=redis://127.0.0.1:6379
```

Keep `REDIS_ENABLED=false` for a local setup without Redis. To use Redis, install/start Redis and set `REDIS_ENABLED=true` with a reachable `REDIS_URL`.

### 5. Set a unique kiosk attestation secret

Do **not** use the development fallback secret in a real deployment. Generate a random value:

```bash
node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"
```

Put that same value in `backend/.env` as `KIOSK_SECRET`, and export it in the shell that launches Electron:

```bash
export KIOSK_SECRET="paste-the-same-generated-value-here"
```

On Windows PowerShell, use `$env:KIOSK_SECRET = "the-same-value"`. The Electron main process reads this secret from its process environment, while the backend loads `backend/.env`; both sides must use the same value for kiosk attestation verification.

### 6. Start the application

```bash
npm start
```

The Electron main process attempts to start the backend on port `4000` if it is not already running, then connects to it. The backend expects PostgreSQL to be available before it can finish starting.

For backend-only development, run:

```bash
npm run start:backend
```

Then start the desktop app in another terminal with `npm start`. Avoid starting multiple backend instances on the same port.

## Development and tests

Install backend dependencies and run the test suite:

```bash
npm ci --prefix backend
npm test
```

The automated tests cover backend configuration behaviour, including kiosk-attestation validation and CORS origin checks. They are a starting point; integration tests for the database/API and end-to-end tests for the Electron workflows are still needed.

The GitHub Actions workflow runs the test suite and JavaScript syntax checks on pushes and pull requests.

## Security and privacy notes

This application can process sensitive information, including student accounts, exam responses, camera/microphone-derived signals, screenshots/evidence, and exam activity. Before using it with real students:

- Obtain appropriate consent and provide a clear privacy notice.
- Define retention, access-control, and deletion policies for exam data and evidence.
- Use unique secrets and strong database credentials; never commit `.env` files or credentials.
- Do not commit real student data, webcam images, screenshots, or evidence files.
- Review authentication, authorization, session handling, evidence storage, and deployment configuration before exposing the backend to a network.
- Treat every automated monitoring result as a prompt for human review, not an automatic finding of misconduct.
- Validate kiosk behaviour on each target operating system. Application-level shortcut blocking is not equivalent to a hardened kiosk device.

This repository is under active development and has not been independently security-audited or certified for high-stakes examinations.

## Contributing

Contributions, bug reports, and practical feedback are welcome. Before opening a pull request:

1. Describe the problem and the expected behaviour.
2. Keep changes focused and avoid including real student data or secrets.
3. Run `npm test` and the relevant manual checks.
4. Include reproducible steps and screenshots made with synthetic data when a UI change is involved.

## License

There is currently no top-level `LICENSE` file. The root and backend npm manifests declare `ISC`, but that metadata alone is not a substitute for the full license text. The maintainers should confirm that all contributors have authority to license their contributions and agree on the intended terms before adding a repository license. Until then, do not assume that the repository is licensed for reuse, modification, or redistribution.
