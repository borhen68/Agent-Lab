# Contributing Guide

Thanks for contributing to Agent Strategy Lab.

## Ground Rules

- Keep changes small, focused, and testable.
- Do not include secrets in code, logs, or examples.
- Keep backward compatibility unless the change is explicitly breaking.
- Update docs for behavior/API changes.

## Local Setup

```bash
cd backend
npm install
npx prisma generate
npx prisma db push

cd ../frontend
npm install
```

Run dev servers:

```bash
cd backend && npm run dev
cd frontend && npm run dev
```

## Before Opening a PR

Run:

```bash
cd backend && npm run build
cd frontend && npm run build
```

If your change affects backend contracts, include:

- API request/response examples
- Migration notes (if Prisma schema changed)
- UI behavior notes (if frontend affected)

## Pull Request Checklist

- [ ] Scope is clear and minimal
- [ ] Build passes (`backend` and `frontend`)
- [ ] Docs updated (`README`/infra/technical log as needed)
- [ ] No secrets or hardcoded tokens
- [ ] Screenshots/GIF for UI changes (if applicable)

## Commit Guidance

Preferred commit style:

- `feat: ...`
- `fix: ...`
- `docs: ...`
- `refactor: ...`
- `chore: ...`

## Good First Issues

- UX polish for failure and confidence-gate messaging
- Benchmark harness and score export
- Additional domain-specific skill integrations
