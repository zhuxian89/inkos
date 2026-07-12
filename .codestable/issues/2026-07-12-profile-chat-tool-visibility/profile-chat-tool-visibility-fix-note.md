---
doc_type: issue-fix
issue: 2026-07-12-profile-chat-tool-visibility
status: fixed
severity: P1
summary: Profile chat tool calls showed successful local-file operations as failed and hid command details.
tags:
  - profile-chat
  - tools
  - chatkit
---

# Profile Chat Tool Visibility Fix Note

## Problem

Profile chat showed `list_books` and other local-file tools as failed even when the tool completed, and the ChatKit tool card only displayed a thin summary instead of the read/write/search command details expected from the mindfs-style timeline.

## Root Cause

`parseToolResultOk()` only treats tool output as successful when the JSON payload contains `ok: true`, but several profile tools returned arrays or plain objects without that field. The UI therefore marked successful calls such as `list_books` as `error`.

The copied ToolCallCard was also reduced too far: it hid arguments and results behind a single preview and did not preserve the mindfs-style command detail structure.

## Fix

- Standardized profile tool success payloads to always return `{ "ok": true, ... }`.
- Wrapped profile tool execution errors as recoverable tool results so SSE continues and the UI can show the failure detail.
- Added `search_text_files` for local text search before reading files.
- Expanded readable text extensions for local file reads to include common source files.
- Restored tool card command detail visibility with tool-specific labels, icons, status, parameters, results, and errors.
- Kept completed/error tool cards expanded so the command evidence remains visible after the assistant response.
- Removed the roadmap-level downgraded scope and switched profile tool SSE/UI toward the mindfs `ToolCall` information model (`kind/title/content/locations/meta/result`) instead of a preview-only shape.

## Verification

- `npm exec tsx -- apps/web/scripts/check-profile-stream-reducer.ts`
- `npm exec --package typescript@5.8.2 -- tsc -p apps/service/tsconfig.json --noEmit`
- `npm exec --package typescript@5.8.2 -- tsc -p apps/web/tsconfig.json --noEmit`
