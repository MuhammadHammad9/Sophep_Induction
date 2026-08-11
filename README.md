# Sophep_Induction

SOPHEP Recruitment Management System (RMS) — Cycle-based recruitment management system for SOPHEP student society.

## Tech Stack
- **Frontend**: Next.js App Router, React, Tailwind CSS
- **Backend**: PostgreSQL, Supabase (RLS & Auth)
- **Tooling**: npm workspaces, TypeScript, Vitest

## Key Security Features
- **Fail-closed Row Level Security (RLS)**: Database policies restrict data access at the row level. Unset contexts return zero rows.
- **No Client-side Secrets**: Ed25519 signatures used for offline QR tokens (private key stored server-side only).
- **Append-only Audit Logging**: Audit log entries are written in the same transaction as data modifications and cannot be mutated or deleted.
- **Protected Environment Credentials**: `.env` files and secret keys are strictly gitignored (`.env.example` provides non-sensitive parameter schema).

## Quick Start
```bash
# Install dependencies
npm install

# Run frontend development server
npm run dev

# Run verification suite (lint, typecheck, tests)
npm run verify
```

For full implementation rules and architecture details, see [CLAUDE.md](CLAUDE.md) and [rules.md](rules.md).
