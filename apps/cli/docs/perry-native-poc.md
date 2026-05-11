# Perry (TS → native binary) PoC

Exploratory write-up for replacing `bun build --compile` with
[Perry](https://docs.perryts.com/) (`@perryts/perry`) as the producer of the
`supabase` native binary.

> Status: **research / not viable today**. See "Blockers" below.

## Why look at Perry

Today `apps/cli/scripts/build.ts` ships the CLI by invoking `bun build
--compile --minify --target=<target>` for 8 OS/arch combinations. Each
artifact embeds the Bun runtime and lands at ~50 MB. Perry instead AOT-compiles
TypeScript to a real native binary via SWC + LLVM, with no embedded JS engine.
On the local PoC a "hello world" Perry binary is **0.9 MB** vs Bun's ~50 MB —
that is the headline appeal.

## Current Bun-coupled surface in `apps/cli`

Items the build/runtime pin to Bun specifically:

- `bun build --compile` itself (build step).
- `@effect/platform-bun` (`BunServices`) wired into:
  - `src/shared/cli/run.ts`
  - `src/next/config/project-runtime.layer.ts`
  - `src/next/commands/init/init.command.ts`
  - `src/next/commands/functions/{new,list}/*.command.ts`
- Direct `Bun.write(...)` calls in `next/commands/platform/*` (tests and
  `platform-input.unit.test.ts`).
- `bun` shell `$` used in `scripts/build.ts`.
- `dev:*` scripts and CLAUDE.md guidance ("invoke as `bun src/...`").

Heavy `node:*` usage (`fs`, `path`, `os`, `crypto`, `child_process`, `buffer`,
`url`, `util`) is fine — Perry's stdlib covers these (see PoC below).

## Third-party deps to worry about

| Dependency | Risk | Notes |
| --- | --- | --- |
| `effect` | High | Has 1 transitive JS-only dep (`@standard-schema/spec`) that breaks Perry's native path today — see PoC. |
| `@effect/platform-bun` | Blocker | Bun-specific; would need to be swapped for `@effect/platform-node`. |
| `@napi-rs/keyring` | Blocker | N-API native addon; Perry has no documented Node-API host. |
| `ink` + `react` | High | Custom React reconciler, JSX runtime, fibers — not on Perry's native package list. |
| `@clack/prompts` | Medium | Pure JS, ships only built output. |
| `posthog-node` | Medium | Ships built JS. |
| `@vercel/detect-agent` | Low | Small, but JS-only. |
| `@supabase/api`, `@supabase/config`, `@supabase/stack` (workspace) | Medium | We control source — should be TS-native compatible if their own deps are. |

## What I PoC'd

Toolchain: `@perryts/perry@0.5.511` (pre-1.0, weekly patches), Linux x64,
clang 18, system linker. Project files under `/tmp/perry-poc`.

1. **Hello world** — `perry compile hello.ts` → 0.9 MB binary. `process.argv`
   works (with a small quirk: argv[0] is duplicated).
2. **`node:fs` + `node:child_process`** — `readFileSync`, `writeFileSync`,
   `spawnSync` all compile natively and execute. No JS runtime needed.
3. **Effect via `node_modules/effect/dist/esm`** — fails. Perry resolves the
   package entrypoint to compiled ESM JS, falls back to bundling, then tries
   to link `libperry_jsruntime.a` which **is not shipped in
   `@perryts/perry-linux-x64`**. Only `libperry_runtime.a`,
   `libperry_stdlib.a`, and `libperry_ui_gtk4.a` are bundled.
4. **Effect via its `src/` TypeScript** — Perry happily compiles 362 of 363
   modules natively. The one holdout is `@standard-schema/spec`, an Effect
   transitive dep that ships only compiled JS in `dist/`. That single JS
   module re-triggers the jsruntime path → same link failure.

So the practical constraint is: **the entire dep graph must reach Perry as
TypeScript source**, or Perry needs its (currently unshipped on npm) JS
runtime static lib. Neither holds for our stack today.

## Blockers (in priority order)

1. **JS-runtime static lib is not in the npm dist.** Every realistic CLI dep
   graph has at least one transitive JS-only package, so compilation halts
   at link time. Building the runtime requires cloning Perry and running
   `cargo build --release -p perry-jsruntime`. Until that ships in the npm
   package, Perry can only build pure-TS-source apps.
2. **Effect is the dep, not the source.** Even if (1) is solved, Effect's
   npm distribution exports `dist/esm/*.js`. We'd need to either patch the
   resolver to prefer Effect's `src/*.ts` or vendor it. This breaks
   normal pnpm workflows.
3. **`@napi-rs/keyring` won't link.** Perry has no documented N-API host.
   We'd need to either drop the keyring dep (fall back to plaintext file
   storage with permissions) or wait for Perry Node-API support.
4. **Ink + React are unlikely to "just work".** React's reconciler relies on
   patterns (mutable shared state, microtask coalescing, host-config
   abstraction) that Perry's compatibility surface hasn't been advertised
   for. Not on the native-package list. Replacing Ink is a much bigger lift
   than the build swap.
5. **Pre-1.0, weekly patch releases.** Shipping the user-facing CLI to
   thousands of users on a pre-1.0 compiler is a stability bet. No real
   ecosystem track record yet.
6. **Single-target builds today.** I only verified Linux x64. Perry's
   per-target packages exist for all 8 OS/arch combos we ship, but
   cross-compile workflow, glibc-vs-musl, signing, and notarization
   (Apple) all need re-validation independently of Bun's known-good path.
7. **No `import.meta.dir` / `createRequire` equivalent verified.**
   `src/shared/cli/bin.ts` and `src/shared/legacy/go-proxy.layer.ts` use
   `createRequire(import.meta.url)` to locate the bundled Go binary.
   Perry's stance on `import.meta` and CJS interop is undocumented.
8. **Bundling the Go binary.** Bun's `--compile` embeds assets via the
   build manifest. Perry has no equivalent embed mechanism in the public
   docs. The legacy shell relies on resolving `apps/cli-go`'s built
   binary at runtime — would need an alternative (sibling file install
   via the wrapper packages).
9. **No decorators.** We don't use them today; flag for future.

## Suggested plan (if we choose to keep exploring)

The blockers above mean this is not a "swap one build script" change. A
realistic phased plan:

### Phase 0 — derisk, no production impact

- [ ] Confirm with Perry maintainers whether `libperry_jsruntime.a` is
      intended to ship in the npm dist, and the timeline. This single
      answer decides whether (2)/(3) below are even worth attempting.
- [ ] Reach out re: Node-API / N-API support roadmap (keyring).
- [ ] Build `libperry_jsruntime.a` from source locally and retry the
      Effect PoC end-to-end to confirm Effect actually runs (not just
      links). Measure binary size and cold start.

### Phase 1 — runtime decoupling from Bun (independent of Perry)

This is worth doing on its own merits; it makes us portable.

- [ ] Replace `@effect/platform-bun` with `@effect/platform-node` and
      audit `BunServices` callsites. Keep behavior under both via the
      shared service interface.
- [ ] Remove `Bun.write(...)` from `src/next/commands/platform/*`
      (use `node:fs/promises`).
- [ ] Update `dev:*` scripts to also work under `node --import tsx`
      (or `tsgo`). Bun remains the default; node becomes a parallel path.
- [ ] Add a CI matrix that runs the test suite under node to catch
      Bun-specific regressions early.

### Phase 2 — minimal Perry PoC binary

- [ ] Carve out a thin entrypoint that imports only `node:*` + workspace
      packages (no `effect`, no `ink`). For example a trivial `supabase
      version` that prints the embedded version string.
- [ ] Add a `scripts/build-perry.ts` that runs `perry compile` for that
      entrypoint, gated behind an opt-in flag.
- [ ] Ship it as an internal artifact to compare size/cold-start vs the
      Bun binary on macOS + Linux.

### Phase 3 — incremental migration (only if Phase 0/2 cleared)

- [ ] Replace `@napi-rs/keyring` with a Perry-compatible credential
      store (keychain helpers via subprocess, or encrypted file with
      OS-permission ACLs). This unlocks compiling `auth/`.
- [ ] Investigate ink replacement: either a Perry-friendly TUI
      (handwritten ANSI via `node:tty`) or accept that `start` keeps the
      Bun build.
- [ ] Resolve `effect` source-vs-built resolution: vendor or wait for
      Perry to support source-precedence resolution.
- [ ] Cut a dual-publish: Perry binary for "lite" commands, Bun binary
      for full feature set, until parity.

### Phase 4 — full swap

Only after the dep graph compiles end-to-end on all 8 targets, plus signing
and packaging (nfpm, codesign, signtool) are validated.

## Drawbacks / honest assessment

- The headline win is binary size; cold-start and memory are not yet
  measured (Perry's own benchmarks are favorable, but our actual code
  path includes a heavy Effect runtime).
- Perry is solo-maintainer / very new. Adopting it as the production
  compiler for a published CLI risks an unbounded support tail if a
  miscompile, segfault, or platform regression hits a real user.
- The ecosystem assumption is inverted vs npm: Perry expects `src/`
  TypeScript distribution; npm packages overwhelmingly ship `dist/`.
  Every transitive dep becomes a possible blocker.
- Even in a best case we likely lose Ink/React UIs. The `next start`
  dashboard would need to be either rewritten or kept on the Bun build.
- The Bun build today is well-understood, fast, and ships a known-good
  artifact. The improvement from a swap is mostly cosmetic (size)
  unless cold-start and memory measurably move the needle.

## Recommendation

Don't pursue a Perry swap right now. Two cheap follow-ups are worth
doing on their own merits and would unblock a future swap if Perry
matures:

1. **Decouple from `@effect/platform-bun`** (Phase 1). Useful regardless.
2. **Open a discussion with Perry** about jsruntime distribution and
   N-API. If those land, revisit with a real PoC of `supabase version`
   compiled by Perry.

Revisit when Perry hits 1.0, ships `libperry_jsruntime.a` in the npm
dist, and at least one popular non-allowlist package (e.g. `commander`,
`chalk`) is demonstrated to "just work" via `perry compile`.
