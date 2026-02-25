# Open Source Release Checklist

Use this before setting repository visibility to public.

## Legal and Governance

- [ ] `LICENSE` is present and correct.
- [ ] `README.md` explains setup and usage.
- [ ] `CONTRIBUTING.md` and `CODE_OF_CONDUCT.md` are present.
- [ ] `SECURITY.md` includes a real private disclosure channel.

## Secrets and Data Hygiene

- [ ] `.gitignore` excludes `.env`, local DB files, and `node_modules`.
- [ ] No API keys or secrets in commit history.
- [ ] No private/customer data in fixtures, logs, screenshots, or docs.

## CI and Build

- [ ] GitHub Actions CI runs on PRs and `main` pushes.
- [ ] Backend build passes.
- [ ] Frontend build passes.

## Product Trust

- [ ] Confidence gate enabled in production defaults.
- [ ] Provider readiness/errors are visible in UI.
- [ ] Fallback behavior documented (judge fallback, search fallback, quota errors).

## OSS Ergonomics

- [ ] Issue templates enabled.
- [ ] PR template enabled.
- [ ] First issues labeled (`good first issue`, `help wanted`).
- [ ] Initial roadmap/milestones created.

## Launch

- [ ] Publish v0.x tag.
- [ ] Announce with demo GIF/screenshot and quickstart snippet.
- [ ] Monitor first issues and triage within 24-72 hours.
