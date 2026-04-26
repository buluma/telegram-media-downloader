# Contributing

Thanks for taking the time to contribute. This project is a self-hosted Telegram media downloader; the goal is to keep it small, secure, and easy to run.

## Getting started

```bash
git clone https://github.com/botnick/telegram-media-downloader.git
cd telegram-media-downloader
npm ci
npm run lint
npm test
npm start    # interactive CLI; or `npm run web` for the dashboard
```

Requires **Node.js 20+**. The version is enforced via `engines.node` and recommended via `.nvmrc`.

## Submitting a change

1. Fork the repo and create a topic branch off `main` (e.g. `feature/proxy-support`, `fix/queue-leak`).
2. Run the full sanity check before pushing:
   ```bash
   npm run lint && npm test
   ```
3. Add or update tests for any non-trivial change. We prefer the [arrange / act / assert] structure with vitest.
4. Open a PR against `main`. The PR template will ask for a short description, the issue it closes (if any), and a testing note.

### Commit messages

We use [Conventional Commits](https://www.conventionalcommits.org/). Examples:

- `feat(web): pause/resume from the dashboard`
- `fix(downloader): clear scaler interval on stop`
- `docs: troubleshooting for the Docker volume mount`
- `chore(deps): bump telegram to 2.20.0`

Keep the subject line under 72 characters; wrap the body at ~80.

### Code style

- ES Modules everywhere (`"type": "module"`). Use `import.meta.url` to derive `__dirname`.
- Run `npm run format` (Prettier) before committing — there's a Husky `pre-commit` hook that does it for staged files automatically.
- Telegram IDs are strings (`String(id)`) because they exceed `Number.MAX_SAFE_INTEGER` precision in some flows.
- Use the existing utilities — `sanitizeName` for folder names, `loadConfig` for config reads, `safeResolveDownload` for any path coming off the wire — don't reinvent them.
- Prefer narrow exports. New core modules go under `src/core/`; new SPA modules under `src/web/public/js/`.

### What to test

- Anything that touches `src/core/db.js`, `src/web/server.js` auth/path handling, `src/core/web-auth.js`, `src/core/security.js`, or the queue priority should land with a vitest covering the new behaviour.
- UI changes in `src/web/public/` are smoke-tested by hand — describe how you verified them in the PR.

## Reporting bugs / asking for features

Use the templates under "Issues → New issue" so the maintainers don't have to round-trip on missing context. Security bugs go through `SECURITY.md`, **not** the public issue tracker.

## Code of conduct

By participating you agree to abide by the [Contributor Covenant 2.1](./CODE_OF_CONDUCT.md). Be excellent to each other.

## Project structure

```
src/
├── index.js         # CLI entry + interactive menus
├── cli/             # CLI helpers (colors)
├── config/          # config.json loader (self-healing)
├── core/            # engine: monitor, downloader, accounts, security, runtime…
└── web/
    ├── server.js    # Express + WebSocket
    └── public/      # vanilla-JS SPA (no bundler)

scripts/             # one-off scripts (migration, healthcheck)
docs/                # architecture, API, deploy, troubleshooting, audit
tests/               # vitest specs
```

See `docs/ARCHITECTURE.md` for the request flow and `docs/AUDIT.md` for known issues + the roadmap.
