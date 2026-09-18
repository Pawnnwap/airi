# Sovereign Edition (branch `sovereign`)

Base: upstream `main` @ `01e6064` (v0.12.0-beta.5). Architecture and
rationale: the aiyuri repo (`plan.md`, `docs/M0-M1-changelist.md`).

> The vault is her. AIRI is the body. llama.cpp is the substrate.
> The renderer must never become the brain.

## What this branch adds

1. **`packages/sovereign-bridge`** — loopback-only client + seam factory for
   the Sovereign Core service. Copy of the verified package in the aiyuri
   repo (`node scripts/m1_bridge_live_test.ts` = 9/9 there).
2. **`packages/stage-ui/src/libs/sovereign-profile.ts`** — the
   `BUILD_PROFILE=sovereign` compile-time gate.
3. **`packages/stage-ui/src/stores/chat.ts`** (M1 wiring, everything else
   untouched):
   - `getSystemPromptSupplement` → soul supplement (CONSTITUTION + PERSONA)
     prepended to the toolset prompt;
   - `runtimeContextProviders` → vault recall with provenance, matched to the
     last user message;
   - `onUserMessageAppended` → tracks the query for recall;
   - `onAssistantTurnReady` → commits the closed exchange to the vault;
   - cloud-sync call sites gated behind `!SOVEREIGN_PROFILE`.
   - If the core is unreachable, every seam no-ops — AIRI runs exactly as
     upstream.

## Running the mind

```bash
# in the aiyuri repo
cd services/sovereign-core
python main.py init --name Yuri --user Vladi
python main.py serve               # 127.0.0.1:8700
```

## M0 remaining (release work)

Dependency-level exclusion (delete `@openpanel/web`, `@opentelemetry/*`,
`better-auth`, `@proj-airi/drizzle-duckdb-wasm` from
`packages/stage-ui/package.json` under the profile + remove their import
sites) lands with the profile CI build; grep-audit the bundle for
`openpanel|better-auth|cloud` before any sovereign release.
