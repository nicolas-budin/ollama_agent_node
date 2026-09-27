# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A Node port of the sibling Python project `~/github/ollama_agent`: a demo chat app that talks to a **local Ollama model** (`gemma4:26b`) over `http://localhost:11434/api/chat`. Backend is Fastify 5 in TypeScript, frontend is React (Vite), copied unchanged from the Python project. Single-tenant: one shared conversation history for every visitor, kept in process memory (Ollama is stateless, so every request resends the full history).

The Python project's GitHub Actions CI, Helm chart and Argo CD setup are intentionally **not** ported. Deployment to the local CRC cluster uses a **Tekton pipeline** instead (see "Deployment" below).

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

## Deployment (Tekton on CRC, `tekton/` + `openshift/`)

Documented in French in two files. Keep both in sync when the pipeline or manifests change:
- `tekton/README.md`: from-scratch install guide, every command explained, plus a line-by-line walkthrough of the YAML files.
- `tekton/EXPLOITATION.md`: day-to-day operations (`openshift/` manifests, redeploys, parameters, rollback, image cleanup, troubleshooting, uninstall, design choices).

Step numbers ("étape N") in EXPLOITATION.md refer to README.md.

- OpenShift Pipelines operator (cluster-wide, `tekton/operator-subscription.yaml`, which hardcodes namespace `openshift-operators`). Pipeline `ollama-agent-node` in namespace `ollama-agent-node`. Other manifests carry no `namespace:`: `tekton/` files get it from `-n`, and `openshift/` files from the pod running `deploy`.
- Operator install gotchas (CLI install):
  - CSV `Succeeded` only means the operator is up. Tekton itself (namespace `openshift-pipelines`, the `Task` CRD, bundled tasks) comes ~3 min later. Wait for `oc get tektonconfig` READY=True.
  - The console plugin `pipelines-console-plugin` is created but **not enabled**. Enable it by adding it to `consoles.operator.openshift.io/cluster` `.spec.plugins`, otherwise there is no Pipelines menu.
  - The Developer perspective is disabled on this cluster, so doc paths use the main nav (Pipelines → Pipelines).
- Triggered **manually** (`oc create -f tekton/pipelinerun.yaml`). CRC isn't reachable from the internet, so no GitHub webhook. The pipeline clones **GitHub**, not the local checkout: push first.
- Tasks:
  - `git-clone`, `buildah` and `openshift-client` are the operator's bundled Tasks, referenced with the `cluster` resolver from namespace `openshift-pipelines`. Their results are uppercase (`COMMIT`, `IMAGE_DIGEST`).
  - `test` is an inline `taskSpec` on `node:24-slim`. It sets `HOME`/`npm_config_cache` to `/tmp` because pods run with an arbitrary UID.
- Image tag = full commit SHA. `deploy` substitutes `IMAGE_PLACEHOLDER` in `openshift/deployment.yaml` with `image@digest` and applies it once, so never `oc apply` that file directly.
- Pure Tekton: no Argo CD Application manages this namespace, so there is no selfHeal to fight.
- Workspace = fixed PVC `pipeline-source`, not a `volumeClaimTemplate`: the CRC StorageClass is `Retain`, so templates would leak one PV per run.
- `replicas: 1` + `strategy: Recreate` (in-memory history). Route timeout is 5m (SSE streams). `OLLAMA_URL` = the Mac's LAN IP, hardcoded in `openshift/deployment.yaml`.
- `.dockerignore` must keep excluding `node_modules`: the `test` task leaves them in the shared workspace, which is buildah's build context.
