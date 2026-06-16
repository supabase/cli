# Functions Deploy E2E — Manual Playbook

Executable checklist for validating `supabase functions deploy` against a real hosted project.

Run all commands from `local-supabase-test/` unless noted.

## Prerequisites

Run `./scripts/verify-setup.sh` first — it checks each item below.

- [ ] Throwaway Supabase project linked: `supabase link --project-ref $SUPABASE_PROJECT_REF`
- [ ] `supabase login` or `SUPABASE_ACCESS_TOKEN` set
- [ ] Docker running (for `--use-docker` / `--legacy-bundle`)
- [ ] CLI built from `feat/functions-deploy` branch
- [ ] `.env.local` sourced (`SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_PROJECT_REF`)

```sh
source .env.local
```

---

## Phase 0 — Deploy matrix (12 cells)

After **each** cell: run `./scripts/invoke-matrix.sh` (all scope) or `./scripts/invoke-matrix.sh <slug>` (single scope).

### Track A — linked (omit `--project-ref`)

| ID | Mode | Scope | Command | Deploy OK | Invoke OK | Notes |
|----|------|-------|---------|-----------|-----------|-------|
| A1a | default | single | `./scripts/deploy-matrix.sh default single linked` | | | |
| A1b | default | all | `./scripts/deploy-matrix.sh default all linked` | | | expect deprecated-map warning |
| A2a | api | single | `./scripts/deploy-matrix.sh api single linked` | | | |
| A2b | api | all | `./scripts/deploy-matrix.sh api all linked` | | | |
| A3a | docker | single | `./scripts/deploy-matrix.sh docker single linked` | | | expect Bundling stderr |
| A3b | docker | all | `./scripts/deploy-matrix.sh docker all linked` | | | |

### Track B — explicit `--project-ref`

| ID | Mode | Scope | Command | Deploy OK | Invoke OK | Notes |
|----|------|-------|---------|-----------|-----------|-------|
| B1a | default | single | `./scripts/deploy-matrix.sh default single explicit-ref` | | | |
| B1b | default | all | `./scripts/deploy-matrix.sh default all explicit-ref` | | | |
| B2a | api | single | `./scripts/deploy-matrix.sh api single explicit-ref` | | | |
| B2b | api | all | `./scripts/deploy-matrix.sh api all explicit-ref` | | | |
| B3a | docker | single | `./scripts/deploy-matrix.sh docker single explicit-ref` | | | |
| B3b | docker | all | `./scripts/deploy-matrix.sh docker all explicit-ref` | | | |

**Cross-track:** invoke JSON from Track A and B must match for the same mode + scope.

**Cross-mode:** A1*/A2* bodies match; A3* Docker redeploy matches API bodies.

---

## Phase 0.5 — Negative cases

Run from **unlinked** temp directory (or after unlink in a copy):

| Test | Command | Expect |
|------|---------|--------|
| No link, no ref | `supabase functions deploy deploy-e2e-basic` | exit 1, link/ref hint |
| Conflicting flags | `supabase functions deploy deploy-e2e-basic --use-api --use-docker` | exit 1, mutually exclusive |
| Conflicting flags | `supabase functions deploy deploy-e2e-basic --use-api --legacy-bundle` | exit 1 |
| Conflicting flags | `supabase functions deploy deploy-e2e-basic --use-docker --legacy-bundle` | exit 1 |
| Jobs + docker | `supabase functions deploy --use-docker --jobs 2` | exit 1 |
| Jobs + legacy | `supabase functions deploy --legacy-bundle --jobs 2` | exit 1 |

Re-link before continuing.

---

## Phase 1.5 — `--legacy-bundle`

| ID | Ref | Scope | Command | Deploy OK | Invoke OK | Notes |
|----|-----|-------|---------|-----------|-----------|-------|
| L1a | linked | single | `./scripts/deploy-matrix.sh legacy single linked` | | | |
| L1b | linked | all | `./scripts/deploy-matrix.sh legacy all linked` | | | |
| L2a | explicit | single | `./scripts/deploy-matrix.sh legacy single explicit-ref` | | | |

Invoke JSON should match `--use-docker` for the same slug(s).

---

## Phase 1 — Category spot-checks (optional fast path)

Before full matrix, deploy + invoke these slugs across default / api / docker (linked + explicit-ref on one slug):

- `deploy-e2e-local-imports`
- `deploy-e2e-static-asset`
- `deploy-e2e-npm`
- `deploy-e2e-no-jwt`
- `deploy-e2e-jwt-required`

---

## Phase 2 — Per-flag spot checks

| Flag | Command | Expect | OK |
|------|---------|--------|-----|
| Multi-slug arg | `supabase functions deploy deploy-e2e-basic deploy-e2e-npm` | both invoke OK | |
| `--no-verify-jwt` | `supabase functions deploy deploy-e2e-jwt-required --no-verify-jwt` then invoke without auth | 200 | |
| `--import-map` | `cd scripts && supabase functions deploy deploy-e2e-root-map --import-map ../supabase/import_map.json` | 200, message hello | |
| `--jobs` | `supabase functions deploy --jobs 2` | all slugs deploy | |
| `--prune --yes` | see prune workflow below | remote-only deleted | |
| `--output-format json` | `supabase functions deploy deploy-e2e-basic --output-format json` | JSON stdout | |
| Docker fallback | stop Docker, `supabase functions deploy deploy-e2e-basic --use-docker` | warning + API fallback | |

### Prune workflow (`deploy-e2e-remote-only`)

1. Deploy remote-only once: `supabase functions deploy deploy-e2e-remote-only`
2. Delete local dir: `rm -rf supabase/functions/deploy-e2e-remote-only`
3. Deploy all with prune: `supabase functions deploy --prune --yes` (next) or `supabase functions deploy --prune` with global `--yes` (legacy)
4. Confirm gone: `supabase functions list`

---

## Phase 3 — Legacy shell parity (optional)

Repeat Track A subset (A1a, A1b, A3a) with legacy CLI entrypoint; compare stdout/stderr and invoke bodies.

---

## Invoke reference

```sh
source .env.local
./scripts/invoke-matrix.sh                    # all slugs in functions.txt
./scripts/invoke-matrix.sh deploy-e2e-basic     # single slug
```

### Per-slug expectations

| Slug | Auth | Expected body |
|------|------|---------------|
| `deploy-e2e-basic` | Bearer | `"case":"deploy-e2e-basic","ok":true` |
| `deploy-e2e-local-imports` | Bearer | `"message":"hello-imports"` |
| `deploy-e2e-scoped-map` | Bearer | `"message":"hello"` |
| `deploy-e2e-root-map` | Bearer | `"message":"hello"` |
| `deploy-e2e-deprecated-map` | Bearer | `"message":"hello"` |
| `deploy-e2e-deno-jsonc` | Bearer | `"message":"hello"` |
| `deploy-e2e-custom-entry` | Bearer | `"entry":"handler.ts"` |
| `deploy-e2e-static-in-fn` | Bearer | `"static":"in-fn-static"` |
| `deploy-e2e-static-asset` | Bearer | `"static":true` |
| `deploy-e2e-npm` | Bearer | `"hasClient":true` |
| `deploy-e2e-jsr` | Bearer | `"method":"GET"` |
| `deploy-e2e-dynamic-import` | Bearer | `"value":"lazy-ok"` |
| `deploy-e2e-package-json` | Bearer | `"ok":true` |
| `deploy-e2e-no-jwt` | none | 200, `"ok":true` |
| `deploy-e2e-jwt-required` | none → 401; Bearer → 200 | `"ok":true` |

---

## Full matrix one-liner

Run all 15 deploy+invoke cells (Phase 0 Tracks A & B + Phase 1.5 legacy):

```sh
./scripts/run-full-matrix.sh
```

Compact inline equivalent (same behavior):

```sh
for track in linked explicit-ref; do for mode in default api docker; do for scope in single all; do ./scripts/deploy-matrix.sh "$mode" "$scope" "$track" && { [[ "$scope" == single ]] && ./scripts/invoke-matrix.sh deploy-e2e-basic || ./scripts/invoke-matrix.sh; } || exit 1; done; done; done; for track in linked explicit-ref; do for scope in single all; do [[ "$track" == explicit-ref && "$scope" == all ]] && continue; ./scripts/deploy-matrix.sh legacy "$scope" "$track" && { [[ "$scope" == single ]] && ./scripts/invoke-matrix.sh deploy-e2e-basic || ./scripts/invoke-matrix.sh; } || exit 1; done; done
```

Track A only (6 cells):

```sh
for mode in default api docker; do for scope in single all; do ./scripts/deploy-matrix.sh "$mode" "$scope" linked && { [[ "$scope" == single ]] && ./scripts/invoke-matrix.sh deploy-e2e-basic || ./scripts/invoke-matrix.sh; } || exit 1; done; done
```
