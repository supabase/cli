---
name: add-compute-runtime
description: Add, rename or remove a `supabase compute` runtime — a `--runtime` choice with its own starter files under `shared/compute/stacks/`. Use when a new kind of compute needs its own scaffold, or when a build fails because COMPUTE_RUNTIMES and stacks/ disagree.
---

# Add a compute runtime

A runtime is two declarations that must agree: an entry in `COMPUTE_RUNTIMES`
(`apps/cli/src/shared/compute/compute-runtimes.ts`) and a directory of starter
files under `apps/cli/src/shared/compute/stacks/`. `compute-stacks.macro.ts`
reads the directory at build time and fails the build when the two disagree, so
a half-added runtime never ships.

## Pick the class first

- **Catalog** — the platform builds it on a base image it already knows
  (`node`, `deno`). `push` sends the name as `spec.runtime`.
- **Context-built** — the starter carries its own `Dockerfile` (`dockerfile`,
  `actions-runner`). `push` sends no `spec.runtime`; the API never learns the
  name, and the uploaded context is built as the image it describes.

The class decides whether this is a CLI change at all: a catalog runtime needs
the Compute API to support the name first, so a runtime you can add CLI-side
alone is context-built.

## Steps

1. **Declare it.** Add the name to `COMPUTE_RUNTIMES` and a one-line entry to
   `COMPUTE_RUNTIME_DESCRIPTIONS` — that string is what `--runtime`'s prompt and
   help show. For a context-built runtime, add it to `CONTEXT_BUILT_RUNTIMES`
   too; `apiRuntimeFor` and `deployedRuntimeLabel` both read that set, so `push`
   omits the runtime and `status`/`list` still name it from the config entry.

2. **Write the stack.** One directory under `stacks/<runtime>/`. The macro reads
   only the files directly inside it — a subdirectory is skipped, so the starter
   is flat or it is incomplete. Scaffolded files land at mode 0644, so anything
   the image executes gets its `chmod` in the `Dockerfile`. Files are written
   verbatim: a `README.md` in the stack is scaffolded into the user's compute
   directory, which is how a runtime that needs credentials explains itself.

3. **Give it runtime-specific defaults** when the global ones are wrong for it.
   `defaultExposureFor` is the precedent: a compute that only makes outbound
   calls records `private` instead of the global `public`. Keep the default that
   `push` falls back to global — `new` writes the value down, so the per-runtime
   default only has to be right at scaffold time.

4. **Follow the name through the prose.** The runtime catalog is restated in
   `packages/config/src/compute.ts` (the published `runtime` description),
   `stacks/README.md` (the table), and the `SIDE_EFFECTS.md` of any command
   whose behavior now varies by runtime.

5. **Cover it.** `compute-runtimes.unit.test.ts` for the catalog helpers,
   `push.integration.test.ts` for the deploy spec the runtime produces — its
   unknown-runtime test asserts the full offered list, so it fails until you
   update it — and `new.integration.test.ts` for what the scaffold writes.
   Fixtures in `compute-stacks.integration.test.ts` derive from
   `COMPUTE_RUNTIMES`; keep them derived rather than listing runtimes by hand.

6. **Scaffold it for real** before calling it done:

   ```sh
   SUPABASE_EXPERIMENTAL_COMPUTE=1 pnpm exec bun src/main.ts \
     compute new demo --runtime <runtime> --workdir "$(mktemp -d)"
   ```

   Then build what it wrote. A stack that scaffolds but does not build is the
   failure this step exists to catch.

Done when the scaffold builds, `pnpm check:all` passes from the repo root, and
the compute unit and integration suites pass.

## Gotchas

- Run the suites through the workspace scripts (`bun --bun vitest`). Plain
  `pnpm exec vitest` runs them on Node, where every compute test fails to import
  `@effect/platform-bun`.
- `knip` strips the `export` from a helper nothing outside the module uses, and
  `pnpm fix:all` applies that edit — expect it on a predicate you added for
  readability, and let it happen.
