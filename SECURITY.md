# Security Policy

## Reporting a vulnerability

**Please do not open a public GitHub issue for security vulnerabilities.**

Instead, report privately to the maintainers via one of:

- **GitHub private vulnerability reporting** — [Open a draft advisory](https://github.com/botnick/telegram-media-downloader/security/advisories/new) (preferred — keeps the report linked to the repo)
- **Email** — open an issue asking for a contact address if no email is published yet

Please include:

- A description of the vulnerability and the affected component (CLI, web server, SPA, packaging, etc.)
- The exact version / commit you tested against
- A minimal reproduction (HTTP request, CLI command, code snippet)
- The impact you believe it has (data exposure, RCE, auth bypass, DoS, etc.)
- Whether you'd like credit in the public advisory

We aim to acknowledge reports within **5 business days** and to ship a fix within **30 days** for high/critical issues, sooner for actively-exploited bugs.

## Supported versions

Only the latest minor release on the `main` branch receives security fixes today. Once we publish 2.0.0, the previous minor (`1.x`) will get backports for **6 months** after `2.0.0` releases.

| Version | Supported |
|---|:---:|
| `main` (HEAD) | ✅ |
| Latest tagged release | ✅ |
| Older tags | ❌ |

## Scope

In scope:

- Authentication and authorization on the web dashboard (REST + WebSocket)
- Path traversal, file disclosure, file deletion via the web layer
- XSS / CSRF in the SPA
- Command injection or unsafe shell invocations
- Secret leakage (Telegram API hash, session tokens, web auth password) in API responses or logs
- Path / shell injection via group names, file names, or any user-controlled input
- Cryptographic weaknesses (key derivation, AES use, session storage)
- Supply-chain weaknesses (lockfile, post-install scripts, Docker base image)

Out of scope:

- Issues that require a Telegram-account compromise to exploit (we cannot defend against a compromised user account)
- DoS via running with deliberately tiny resource limits
- Self-XSS that requires the victim to paste an attacker payload into their own browser console
- Telegram's own ToS questions — those are between the user and Telegram

## Disclosure timeline

We follow **coordinated disclosure**: we will work with you on a fix, publish an advisory once a patched release ships, and credit you (with permission). We will not pursue legal action against good-faith researchers who follow this policy.

## Hardening recommendations for operators

Until 2.0.0 ships:

1. **Set a web password** — open `npm run auth` and pick one. Without it, the web dashboard is open to anyone who can reach `:3000`.
2. **Do not expose `:3000` directly to the public internet.** Put it behind a reverse proxy (Caddy, nginx, Traefik) with HTTPS and IP allowlisting.
3. **Back up `data/secret.key`** — losing it makes every encrypted session unrecoverable.
4. **Run only one writer to `data/db.sqlite` at a time.** Either the CLI or the web server, not both, until the IPC isolation in milestone M2 lands.
5. **Pin the Docker image** — use a digest (`sha256:…`) rather than the floating tag.

See `docs/AUDIT.md` for the full list of known issues that the upcoming releases will address.
