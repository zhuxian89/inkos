# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Overview

InkOS is an autonomous novel production system built as a TypeScript pnpm monorepo. It orchestrates multiple LLM agents to draft, audit, and revise fiction chapters while maintaining long-term story memory via markdown truth files. Entry points: Web UI, Service API, and CLI.

## Build Commands

Package manager: **pnpm** (>=9.0.0), Node >=20.0.0.

```bash
# Install dependencies
pnpm install

# Build everything (core must build first — others depend on its dist/)
pnpm build

# Build just the web stack (sequential: core → cli → service → web)
pnpm build:web

# Run all tests (vitest)
pnpm test

# Run tests for a single package
pnpm --filter @actalk/inkos-core test

# Run a single test file
pnpm --filter @actalk/inkos-core test -- src/__tests__/state-manager.test.ts

# Type-check all packages (builds core first since others import it)
pnpm typecheck

# Lint all packages
pnpm lint
```

### Local Development (three terminals)

```bash
# T1: Watch-build core (required — service/cli import dist/)
pnpm --filter @actalk/inkos-core dev

# T2: Start service (Express, port 4010)
INKOS_HOME=$HOME/inkos-data/inkos-home INKOS_PROJECT_ROOT=$HOME/inkos-data/project \
  pnpm --filter @actalk/inkos-service dev

# T3: Start web (Next.js, port 3000)
INKOS_SERVICE_URL=http://127.0.0.1:4010 pnpm --filter @actalk/inkos-web dev
```

Or run all at once: `pnpm dev:web`

### Docker

```bash
docker compose -f docker-compose.web.yml up -d --build   # production
docker compose -f docker-compose.dev.yml up -d            # dev with hot-reload
```

## Architecture

### Monorepo Layout

| Package | Name | Role |
|---------|------|------|
| `packages/core` | @actalk/inkos-core | Agents, pipeline runner, LLM provider, state manager, models (Zod) |
| `packages/cli` | @actalk/inkos | Commander.js CLI — `inkos` binary |
| `apps/service` | @actalk/inkos-service | Express REST API (port 4010), job management, PostgreSQL chat persistence, SQLite LLM profiles |
| `apps/web` | @actalk/inkos-web | Next.js 15 + Ant Design 5 frontend; API routes are reverse proxies to service |

**Dependency direction:** web → service → core ← cli. Both service and cli import `@actalk/inkos-core` from workspace. The web app never imports core directly — it calls service via HTTP.

### Agent Pipeline (packages/core)

The `PipelineRunner` orchestrates a multi-agent pipeline per chapter:

1. **ArchitectAgent** — generates story bible, volume outline, character matrix during book init
2. **WriterAgent** — drafts chapters and updates all 7 truth files atomically
3. **ContinuityAuditor** — 32-dimension quality audit (genre-aware)
4. **PostWriteValidator** — deterministic rule checks (no LLM cost)
5. **AITellAnalyzer** — heuristic AI-marker detection (40+ patterns)
6. **SensitiveWordsAnalyzer** — sensitive content check
7. **ReviserAgent** — fixes issues in 5 modes: `polish`, `rewrite`, `rework`, `spot-fix`, `anti-detect`
8. **RadarAgent** — scans platform trends (Feilu, Qidian, Tomato)

`runAgentLoop` (pipeline/agent.ts) exposes all agents as tool-calling functions for natural-language agent mode.

### Truth Files (Long-Term Memory)

Per-book state lives in `books/{bookId}/story/`:

- `current_state.md` — character positions, relationships, goals
- `character_matrix.md` — character info boundaries and interactions
- `chapter_summaries.md` — compressed per-chapter recap
- `pending_hooks.md` — unresolved foreshadowing
- `subplot_board.md` — subplot progression
- `emotional_arcs.md` — character emotional trajectory
- `particle_ledger.md` — in-world resource/item accounting

WriterAgent updates these after every chapter. StateManager snapshots all truth files per chapter (`story/snapshots/{N}/`) for rollback.

### LLM Provider Layer (packages/core/src/llm/provider.ts)

Supports Anthropic and OpenAI (including compatible APIs). Key config fields: `provider`, `baseUrl`, `apiKey`, `model`, `temperature`, `maxTokens`, `thinkingBudget`, `apiFormat` (chat | responses). Streaming with fallback. Unified tool-calling interface across providers.

### Service Architecture (apps/service)

Single-file Express app (`src/index.ts`, ~3700 lines) with 40+ REST endpoints. Key patterns:

- **Async jobs**: Long operations (write, audit, revise, chat) return `{ jobId }` immediately; frontend polls `GET /api/jobs/:jobId`
- **Chat persistence**: PostgreSQL (configurable via `inkos.json`)
- **LLM profiles**: SQLite at `~/.inkos/profiles.db`; active profile written to `~/.inkos/.env`
- **CLI delegation**: Some endpoints call the CLI binary via `spawnCli()` with retry logic

### Web Frontend (apps/web)

Next.js 15 App Router with React 19 + Ant Design 5. All `/api/inkos/*` routes are thin reverse proxies (`fetch → service:4010 → NextResponse`). Client components fetch these proxy routes. Theme: custom teal (#5f8f8a).

### Configuration Priority

1. Process environment variables (`INKOS_LLM_*`)
2. Project `.env` (`INKOS_PROJECT_ROOT/.env`)
3. Global `.env` (`INKOS_HOME/.env`)

### Key Environment Variables

| Variable | Default | Purpose |
|----------|---------|---------|
| `INKOS_HOME` | `~/.inkos` | Global config dir |
| `INKOS_PROJECT_ROOT` | cwd | Project workspace |
| `INKOS_LLM_PROVIDER` | — | `openai`, `anthropic`, or `custom` |
| `INKOS_LLM_BASE_URL` | — | LLM API endpoint |
| `INKOS_LLM_API_KEY` | — | LLM API key |
| `INKOS_LLM_MODEL` | — | Model name |
| `INKOS_SERVICE_URL` | `http://127.0.0.1:4010` | Service URL for web app |

## CI

GitHub Actions (`.github/workflows/ci.yml`): builds and tests on Node 20 and 22, then verifies `workspace:*` references are resolved before npm pack.

## Publishing

`pnpm release` builds, tests, then publishes `packages/*`. The `prepare-package-for-publish.mjs` script replaces `workspace:*` with real versions pre-pack; `restore-package-json.mjs` reverts post-pack.
