# Langfuse Exec Env for OpenClaw

Injects Langfuse credentials into the `exec` tool's environment on a **per-agent** basis, via OpenClaw's `resolve_exec_env` plugin hook.

## Why this exists

All agents in an OpenClaw gateway process share one `process.env` — a container-level env var (e.g. via `docker-compose.yml`) is visible to every agent's shell commands identically. That's fine for sending traces out (see [`langfuse-tracer`](../langfuse_tracer)), but it breaks down the moment an agent's **skill** needs to read data *back* from Langfuse (e.g. [`sql-audit-trace`](../../sql-audit-trace), which shells out to `npx langfuse-cli` or the Langfuse HTTP API): every agent would read back the same Langfuse project, regardless of which project actually holds that agent's own traces.

This plugin solves that without touching docker-compose or requiring one container per agent: it hooks `resolve_exec_env`, which OpenClaw calls right before every `exec` tool invocation, with the invoking agent's ID available on the hook context. The plugin looks up that agent ID against a configured list of Langfuse credential groups and injects the matching project's keys into that one exec call's environment — nothing global changes, and other agents' exec calls get their own (or no) credentials independently.

## Configuration

```bash
openclaw config set plugins.entries.langfuse-exec-env.config.credentials '[
  {"publicKey":"pk-lf-teamA","secretKey":"sk-lf-teamA","agentIds":["teamA-agent"]},
  {"publicKey":"pk-lf-teamB","secretKey":"sk-lf-teamB","agentIds":["teamB-agent"]}
]'
openclaw gateway restart
```

- Each array entry is one Langfuse project's credentials, optionally scoped to `agentIds`.
- An entry with no `agentIds` (or an empty list) is the **default/catch-all** group, used for any agent not matched by a more specific entry.
- `baseUrl` defaults to `http://172.21.0.1:3050` per entry if omitted.

No `hooks.allowConversationAccess` grant is required — this plugin only reads the invoking agent's ID, never conversation content.

## What gets injected

For every `exec` call made by a matched agent:

| Env var | Read by |
|---|---|
| `LANGFUSE_PUBLIC_KEY` / `LANGFUSE_SECRET_KEY` / `LANGFUSE_HOST` | `npx langfuse-cli` and the official Langfuse SDKs |
| `AGENT_LANGFUSE_PUBLIC_KEY` / `AGENT_LANGFUSE_SECRET_KEY` / `AGENT_LANGFUSE_BASE_URL` | `sql-audit-trace`'s Step 0 HTTP-API fallback (kept under a separate prefix so it can't collide with the host's own `LANGFUSE_*` env vars) |

## Relationship to `langfuse-tracer`

This plugin is intentionally separate from [`langfuse-tracer`](../langfuse_tracer) rather than merged into it:

- `resolve_exec_env` runs synchronously on **every** `exec` call across every agent — a hot path where a bug has broad blast radius. `langfuse-tracer`'s work happens async, off the critical path.
- This plugin needs no conversation-content access; `langfuse-tracer` does.
- The two plugins can be installed/enabled independently.

Each plugin defines its own `credentials` config, kept in sync manually (or via a shared secret-ref alias in `openclaw.json`) rather than one plugin reading the other's config — so disabling or removing either one never breaks the other.

## Building From Source

**OpenClaw never executes the TypeScript source directly.** `package.json`'s `main`/`exports` point at `./dist/index.js`, and `plugins.load.paths`/`openclaw plugins install` resolve the plugin through those fields — so only compiled output in `dist/` is ever loaded, not `index.ts`/`api.ts`/`src/exec-env.ts`.

`dist/` is committed to this repo, so a fresh clone or `openclaw plugins install` works immediately without building anything. You only need to build when you **edit the source** — until you rebuild, OpenClaw keeps running whatever `dist/` already contains.

```bash
npm install   # one build-time dependency: TypeScript itself (zero runtime deps)
npm run build # index.ts / api.ts / src/*.ts → dist/
npm run clean # remove dist/ for a clean rebuild
```

Then restart (or reinstall) so OpenClaw picks up the new `dist/`:

```bash
openclaw gateway restart
# or, if installed with `-l` (symlinked): openclaw plugins install . -l
```

If you're committing a source change, commit the regenerated `dist/*` files in the same change.

### Expected build warnings (safe to ignore)

Building standalone — without the `openclaw` package available for type resolution — always prints:

```
api.ts:1:63 - error TS2307: Cannot find module 'openclaw/plugin-sdk/plugin-entry' or its corresponding type declarations.
index.ts:1:35 - error TS2307: Cannot find module 'openclaw/plugin-sdk/plugin-entry' or its corresponding type declarations.
index.ts:9:12 - error TS7006: Parameter 'api' implicitly has an 'any' type.
src/exec-env.ts:100:31 - error TS7006: Parameter 'event' implicitly has an 'any' type.
src/exec-env.ts:100:38 - error TS7006: Parameter 'ctx' implicitly has an 'any' type.
```

This is expected: `index.ts`/`api.ts` import a subpath (`openclaw/plugin-sdk/plugin-entry`) that only resolves inside a real OpenClaw checkout/install. Once that import can't be resolved, `api`'s type collapses to `any`, cascading into every `api.on(...)` handler — one root cause, not several bugs.

`tsc` still exits non-zero (so `npm run build` reports failure to any script checking its exit code), **but it still emits working JS into `dist/`** — `tsconfig.json` sets `"noEmitOnError": false` specifically so this doesn't block the build. Verify by diffing `dist/` after building; if your source edit shows up there, the build did what it needed to.
