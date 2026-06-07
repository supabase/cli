# CLI Code Structure

The CLI is organized into lowercase top-level slices under `src/`:

```text
src/
  cli/
  commands/
  docs/
  auth/
  config/
  output/
  runtime/
  telemetry/
```

## Why This Structure

- `commands/` is the user-facing entry point. Each command owns its own parsing, handler, and tests.
- `auth/`, `config/`, `output/`, `runtime/`, and `telemetry/` are reusable concern slices shared by multiple commands or flags.
- `docs/` owns shared command documentation content and renderers used by both the runtime CLI and the docs generation script.
- Shared concern slices still split contracts from implementations:
  - `*.service.ts` defines Effect services and public interfaces
  - `*.layer.ts` defines live implementations and wiring

This split keeps the service contract readable on its own and prevents large implementation files from turning the service definition into a mixed abstraction + wiring file. The flatter layout is preferred because it maximizes colocation and avoids adding extra folders when the file suffix already communicates the role clearly.

## Dependency Direction

- `cli/` may import from `commands/`, `docs/`, and concern slices.
- `commands/` may import from concern slices.
- `auth/`, `config/`, `output/`, `runtime/`, and `telemetry/` must not import from `commands/` or `cli/`.
- `docs/` must not import from `cli/` or `commands/`.
- Commands must not import another command's internals.

Use direct file imports. Do not add barrel `index.ts` files.

## Naming Rules

Folders are lowercase everywhere.

Command files:

```text
commands/login/
  login.command.ts
  login.handler.ts
  login.errors.ts
  login.integration.test.ts
  login.e2e.test.ts
```

Shared concern files:

```text
auth/
  credentials.service.ts
  credentials.layer.ts
  errors.ts
```

Rules:

- Command files use the command name as a prefix.
- Flow files use `<topic>.flow.ts`.
- Shared service files use `<topic>.service.ts`.
- Shared layer files use `<topic>.layer.ts`.
- Do not prefix leaf files with the slice name.
  - `tracing.layer.ts`, not `telemetry.tracing.layer.ts`
  - `credentials.service.ts`, not `auth.credentials.service.ts`

## Symbol Naming

- Service symbols are plain nouns: `Credentials`, `Tracing`, `Output`.
- Layer exports use concrete `*Layer` names: `credentialsLayer`, `tracingLayer`, `outputLayer`.
- Do not use `.Default`.
- Do not rely on `static layer` as the default pattern for shared concern slices.

## Slice Layout

Each shared concern slice should prefer this shape:

```text
<slice>/
  <topic>.service.ts
  <topic>.layer.ts
  errors.ts
  types.ts
  schemas.ts
```

Only keep the root files the slice actually needs. Root-of-slice files are for real slice-owned artifacts such as:

- `errors.ts`
- `types.ts`
- `schemas.ts`
- `consent.ts`
- `identity.ts`
- `json-formatter.ts`

Only introduce `services/` or `layers/` folders later if a slice becomes genuinely crowded or needs distinct implementation families. They are an exception, not the default.

If code is shared across multiple commands, move it into the owning concern slice. If it is only used by one command, keep it inside that command.

`docs/` is a special slice. It may contain pure helpers such as:

- `command-docs.ts`
- `markdown-formatter.ts`

## Command-Local Folders

Commands stay flat by default. Add extra folders only when the command genuinely needs them:

- `flows/` for orchestration paths
- `ui/` for Ink mini-app code and UI-local state/model files

Do not add generic `lib/`, `utils/`, or `modes/` folders inside commands.

If a command needs private DI, prefer colocated `*.service.ts` and `*.layer.ts` files in the command folder instead of adding nested folders by default.

## Error Placement

- Slice-wide errors live at the slice root in `errors.ts`.
- Command-specific errors live in `<command>.errors.ts`.
- If an error starts command-local and becomes shared, promote it to the owning concern slice.

## Comments

- Comment shared boundaries and non-obvious orchestration, not every file mechanically.
- Prefer short file headers on meaningful `*.service.ts` and `*.layer.ts` files.
- Use section comments in large layer files when the implementation has distinct phases or policy branches.
- Avoid comments on trivial wrappers and obvious code paths.
- Avoid comments that only restate the code line by line.

Examples where comments are expected:

- `telemetry/tracing.layer.ts`
- `output/output.layer.ts`
- `auth/credentials.layer.ts`

Consistency does not mean every service or layer file needs a header. The goal is high-signal comments on important boundaries.
