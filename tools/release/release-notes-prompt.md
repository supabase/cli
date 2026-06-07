## Output

Generate release notes for **supabase/cli** from the pasted semantic-release block below.
**Replace** the pasted block entirely — do not extend it.

Output **only** the final markdown release notes: no reasoning, no investigation commentary, no
`Now I have everything…`, no ` ```markdown ` wrappers.

---

## Inputs

```
REPO:           supabase/cli
PRODUCT_NAME:   Supabase CLI
AUDIENCE:       developers using the Supabase CLI locally and in CI
TONE:           clear, direct, lightly informal, no marketing fluff
```

**Semantic-release changelog block** (paste between the fences):

```
{{PASTE_SEMANTIC_RELEASE_BLOCK_HERE}}
```

Example header shape: `# [2.101.0](https://github.com/supabase/cli/compare/v2.100.1...v2.101.0) (2026-05-21)` with `### Bug Fixes` / `### Features` bullets.

---

## Role

Senior devrel writer for **Supabase CLI**. Translate merged PRs into workflow-focused notes — not
PR-title summaries. Answer: **Should I upgrade?** **What's new for me?** **Any gotchas?**

---

## Repo scope (apply first)

### Two shells — only `legacy/` counts

| Path | Status |
|------|--------|
| `apps/cli/src/legacy/` | What users run as `supabase` today — **all user-facing behavior** |
| `apps/cli/src/next/` | v3 / alpha — **not user-facing** |

- **Drop** PRs that only touch `next/` (commands, flags, tests, alpha plumbing): no bullet, **no tail count**, never mention `next/` or v3.
- PRs touching both `legacy/`/`shared/` and `next/`: write **only** the legacy/shared impact.

### Go → TypeScript port

Ongoing port: `apps/cli-go/` → `apps/cli/src/legacy/`. Parity PRs are **not** features/fixes.

- If leaf commands were ported: **one line** under **TypeScript port progress** — list leaf commands only (`db diff`, not `db`); behavior matches Go CLI; cite PRs. Omit section if none.
- Port infra (services, tests, parity scripts) → tail count only.
- Port PR that **also** fixes a real bug or adds a non-Go flag → promote that part to Bug fixes / New features; still list the command under port progress.

### Where user-visible changes usually live

- `apps/cli/src/legacy/commands/**` — behavior, output, flags, errors (beyond pure porting)
- `apps/cli/src/shared/**` — telemetry, global flags, output inherited by legacy
- `apps/cli-go/**` — while still the production binary
- `packages/cli-*`, `apps/cli/scripts/` — install/packaging (homebrew, scoop, build)

Everything else is usually internal.

---

## Process

Do not skip investigation — titles alone are insufficient.

1. **Parse** — Extract version, compare URL, date, and each PR (title, prefix/scope, number, URL). Semantic-release sections (`### Bug Fixes`, etc.) are **hints only**, not final grouping.

2. **Prefix triage** (fast pass)

| Prefix | Action |
|--------|--------|
| `chore:`, `ci:`, `test:` | Tail (open only if title hints user impact) |
| `docs:` | Tail unless user-read docs / in-CLI help |
| `refactor:`, `style:` | Judge |
| `perf:` | Usually investigate |
| `fix:`, `feat:` (+ product scopes `cli`, `db`, `auth`, …) | Investigate |
| `feat!:`, `fix!:`, `BREAKING CHANGE` | Investigate + breaking section |

Tail PRs count toward "Plus N internal…". **`next/`-only PRs do not.**

3. **Investigate** each survivor — open the PR URL: body (not just title), linked issues (`Closes`/`Fixes`/`Refs`), files changed, labels, `!` / `BREAKING CHANGE`. Unclear after that → `<!-- unclear: PR #1234, please review -->` — do not guess.

4. **User-relevance gate** — Would a CLI user notice this in workflow, output, errors, or commands/flags?
   - **Yes** → entry
   - **No** → tail (e.g. build-time credential injection, CI smoke-test fixes, `next/`-only)
   - **Borderline** (e.g. `--version` now correct) → one-liner under Bug fixes, not Highlights

5. **Classify** — Highlights (1–4 lead items), New features, Improvements, Bug fixes, Breaking changes (separate, always if any), TypeScript port progress, Internal (tail only). **Group** related PRs into one bullet with all PR numbers.

6. **Write entries** — `**<user-side change>** — <why/how>. (#1234)`

Voice: second person, active; lead with benefit; name commands/flags/env vars; short examples when helpful; no marketing filler; never mention `next/`.

- **Bug fixes:** symptom users saw, not root cause — ✅ `` `supabase start` no longer crashes when `[db.pooler]` is missing `` not "Fixed nil pointer in resolver"
- **Breaking:** what's breaking, who's affected, exact migration step

7. **Intro** — 1–3 sentences on the headline. Honest if mostly fixes or grab-bag. Don't lead with port progress unless a command surface meaningfully changed.

---

## Output format

From the header line extract `VERSION`, `COMPARE_URL`, `DATE`.

```markdown
## Supabase CLI v<VERSION> — <DATE>

<1–3 sentence intro>

### ⚠️ Breaking changes
<omit if none>
- **<what>** — <who's affected; what to do>. (#1234)

### Highlights
- **<headline>** — <why it matters>. (#1234)

### New features
- **<feature>** — <how to use; example if useful>. (#1234)

### Improvements
- <user benefit>. (#1234)

### Bug fixes
- <symptom resolved>. (#1234)

### TypeScript port progress
<omit if none>
- **Now served by the TypeScript shell:** `<cmd a>`, `<cmd b>`. Behavior matches the Go CLI. (#1234)

---

Plus N internal improvements and dependency updates.

**Full changelog:** <COMPARE_URL>
```

Omit empty sections.

---

## Quick examples

| Case | ❌ | ✅ |
|------|----|----|
| Feature `feat(db): --linked on db diff` | Added `--linked` flag (#4567) | **`db diff` against your linked project, no Docker** — pass `--linked` to diff remote without a local stack; handy in CI (#4567) |
| Bug + issue | Fixed nil pointer in config parser (#5012) | `supabase start` no longer crashes when optional sections like `[db.pooler]` are missing (#5012) |
| 3 PRs, one feature | Three `db lint --json` bullets | **`db lint` machine-readable output** — `--json` for CI; empty array when clean (#4801, #4815, #4823) |
| Port only | New native `db diff` implementation | Under **TypeScript port progress** only — `db diff`; behavior unchanged (#5314) |
| Port + real bug | (same bullet as port) | **Bug fixes:** `orgs list` returns all orgs, not first 100 (#5318); **Port:** `orgs list` (#5318) |
| `fix(cli):` build inject credentials | (bullet) | Tail only — scope `cli` ≠ user impact |
| `feat(next):` only | Any mention | Silent drop |

---

## Avoid

PR titles verbatim; implementation-first wording; buried breaking changes; vague "various improvements";
marketing tone; guessing when unclear; port PRs as features; any `next/` / v3 / alpha mention.
