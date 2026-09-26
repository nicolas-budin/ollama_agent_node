# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A Node port of the sibling Python project `~/github/ollama_agent`: a demo chat app that talks to a **local Ollama model** (`gemma4:26b`) over `http://localhost:11434/api/chat`. Backend is Fastify 5 in TypeScript, frontend is React (Vite), copied unchanged from the Python project. Single-tenant: one shared conversation history for every visitor, kept in process memory (Ollama is stateless, so every request resends the full history).

CI/CD, Helm, OpenShift and Argo CD from the Python project are intentionally **not** ported.

## Commands

```bash
npm install
npm run build:front          # frontend/dist, served by the backend
npm start                    # node src/server.ts on :8124
npm run dev                  # node --watch
npm test                     # vitest (backend only, see vitest.config.ts)
npm run typecheck            # tsc --noEmit
npm --prefix frontend test   # frontend vitest (jsdom)
npm --prefix frontend run dev  # :5173, proxies /api to :8124
```

## TypeScript without a build step

Node 24 runs `.ts` files directly (type stripping). Consequences, enforced by `tsconfig.json` (`erasableSyntaxOnly`, `verbatimModuleSyntax`, `allowImportingTsExtensions`):
- imports use explicit `.ts` extensions;
- type-only imports must be `import type` / `type X`;
- no `enum`, `namespace`, or constructor parameter properties.

`tsc` is only a checker (`noEmit`); the Docker image runs `node src/server.ts`.

## Architecture

### `src/ollama-client.ts`
- Module-level `history` (seeded with `SYSTEM_PROMPT`), `getHistory()`, `resetHistory()`, and a shared `lock` (`src/lock.ts`, a promise-chain mutex, the equivalent of `asyncio.Lock`).
- `streamChat(message, { signal, idleTimeoutMs })`: async generator over native `fetch`. It parses Ollama's **NDJSON** stream line by line (keeping a partial trailing line in a buffer) and yields `{type:"text"}` chunks, then `{type:"done", duration_ms, eval_count}`.
- It does **not** take the lock; the caller holds it for the whole turn.
- Differences from the Python version:
  - **History is only mutated on `done`**, when user and assistant messages are pushed together. A failed or aborted stream leaves no orphan user message.
  - **Idle timeout** (`OLLAMA_IDLE_TIMEOUT_MS`, default 120 s), re-armed on every received chunk. It is not a total timeout, so long generations are never cut. Combined with the caller's signal via `AbortSignal.any`; the abort reason is rethrown as-is.
  - A stream that ends without `done`, or an in-stream `{"error": ...}` line, throws.
  - No client singleton: undici's `fetch` already pools connections.

### `src/app.ts`
- `buildApp({ streamChat, logger })` returns the Fastify instance. Tests inject a fake `streamChat` and call `app.inject()`, since ES module exports can't be monkeypatched.
- `POST /api/chat` calls `reply.hijack()` and writes SSE by hand to `reply.raw`, inside `lock.run()`.
  - `sseEvent()` splits multiline `data` into several `data:` lines, as sse-starlette does. The frontend's `parseEvent` rejoins them with `\n`.
  - Events: `text`, `done` (JSON `{duration_ms, eval_count}`), `error` (message).
  - On client disconnect (`reply.raw` `close` before end), the Ollama fetch is aborted so the lock is released, and no `error` event is written.
- `POST /api/reset` resets the history under the same lock.
- `@fastify/static` serves `frontend/dist` at `/`, registered last and only if the directory exists (the equivalent of Python's `check_dir=False`).

### Frontend
Identical to the Python project. Keep the SSE contract above stable: `App.jsx` depends on it.

## Tests
No real network:
- `tests/ollama-client.test.ts` stubs global `fetch` with `Response`s streaming NDJSON. It covers split lines, HTTP errors, truncated streams (history untouched), idle timeout, and caller abort.
- `tests/app.test.ts` asserts exact SSE bodies.
