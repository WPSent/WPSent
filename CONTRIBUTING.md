# Contributing to WPSent

Thanks for taking the time to contribute! WPSent is a (open source and self-hosted) WhatsApp API gateway and every contribution — bug fixes, features, docs, or ideas — is welcome.

---

## Table of Contents

- [Getting Started](#getting-started)
- [Project Structure](#project-structure)
- [Development Setup](#development-setup)
- [Making Changes](#making-changes)
- [Submitting a Pull Request](#submitting-a-pull-request)
- [Bug Reports](#bug-reports)
- [Feature Requests](#feature-requests)
- [Code Style](#code-style)
- [Commit Messages](#commit-messages)

---

## Getting Started

1. **Fork** the repository on GitHub
2. **Clone** your fork locally
   ```bash
   git clone https://github.com/wpsent/wpsent.git
   cd wpsent
   ```
3. **Add the upstream remote** so you can pull in future changes
   ```bash
   git remote add upstream https://github.com/wpsent/wpsent.git
   ```

---

## Project Structure

```
wpsent/
├── server.js          # Entry point — connects MongoDB, starts Express
├── waManager.js       # WhatsApp session manager (RemoteAuth + MongoStore)
├── models/
│   └── index.js       # Mongoose schemas: WpUser, MessageLog
├── routes/
│   └── index.js       # All Express routes + HTML dashboard templates
├── nixpacks.toml      # Railway build config (installs Chromium)
├── railway.toml       # Railway deploy config
├── .env.example       # Environment variable template
└── CONTRIBUTING.md    # You are here
```

---

## Development Setup

### Prerequisites

- Node.js 18+
- MongoDB (local or Atlas free tier)
- Chrome or Chromium installed

### Steps

```bash
# 1. Install dependencies
npm install

# 2. Configure environment
cp .env.example .env
# Edit .env and set MONGO_URI to your MongoDB connection string

# 3. Start in dev mode (auto-restarts on file changes)
npm run dev
```

Open `http://localhost:3000`, enter your phone number, and scan the QR code.

---

## Making Changes

Always work on a **new branch** — never commit directly to `main`.

```bash
# Sync with upstream first
git fetch upstream
git checkout main
git merge upstream/main

# Create your branch
git checkout -b fix/browser-detection
# or
git checkout -b feat/rate-limiting
```

### Branch naming

| Type | Pattern | Example |
|---|---|---|
| Bug fix | `fix/short-description` | `fix/snap-stub-detection` |
| New feature | `feat/short-description` | `feat/rate-limiting` |
| Documentation | `docs/short-description` | `docs/railway-deploy-guide` |
| Refactor | `refactor/short-description` | `refactor/session-manager` |

---

## Submitting a Pull Request

1. **Push** your branch to your fork
   ```bash
   git push origin fix/browser-detection
   ```

2. Open a **Pull Request** on GitHub against the `main` branch

3. Fill in the PR description:
   - What problem does this solve?
   - How did you test it?
   - Any breaking changes?

4. A maintainer will review and merge or request changes

---

## Bug Reports

Please open a [GitHub Issue](../../issues/new) and include:

- **Node.js version** — `node --version`
- **OS** — Ubuntu 22.04 / macOS 14 / Windows 11 etc.
- **Browser** — Chrome / Chromium and version
- **Steps to reproduce** — the exact sequence that triggers the bug
- **Expected behaviour** — what you expected to happen
- **Actual behaviour** — what actually happened
- **Logs** — paste any error output from the terminal

---

## Feature Requests

Open a [GitHub Issue](../../issues/new) with the label `enhancement` and describe:

- The problem you're trying to solve
- Your proposed solution
- Any alternatives you considered

---

## Code Style

WPSent uses plain Node.js with no transpiler — what you write is what runs.

- **2 spaces** for indentation
- **Single quotes** for strings
- **Semicolons** — yes
- **`const`/`let`** — never `var`
- **`async/await`** over raw `.then()` chains
- Keep functions small and focused — if a function is doing two things, split it
- Add a short comment above anything non-obvious

No linter is enforced yet, but PRs with wildly inconsistent style may be asked to clean up.

---

## Commit Messages

Follow the [Conventional Commits](https://www.conventionalcommits.org/) format:

```
type: short summary in sentence case

Optional longer description explaining WHY, not what.
```

**Types:**

| Type | When to use |
|---|---|
| `feat` | A new feature |
| `fix` | A bug fix |
| `docs` | Documentation only |
| `refactor` | Code change that neither fixes a bug nor adds a feature |
| `chore` | Maintenance — deps, config, build scripts |

**Examples:**

```
fix: skip chromium snap stubs during browser detection
feat: add rate limiting to /send endpoint
docs: add Railway deployment guide to README
chore: bump whatsapp-web.js to 1.35.0
```

---

## Questions?

Open a [GitHub Discussion](../../discussions) or file an issue — we're happy to help.
