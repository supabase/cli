# Output Service

The CLI uses a single unified `Output` service (`src/services/Output.ts`) that abstracts all user-facing communication — logging, prompts, and structured results — behind intent-based methods. A `--output-format` flag on the root command selects which layer implementation is used.

## Output Formats

| Format        | Flag                          | Use case                                                                               |
| ------------- | ----------------------------- | -------------------------------------------------------------------------------------- |
| `text`        | default                       | Humans in a terminal — uses `@clack/prompts` for styled output and interactive prompts |
| `json`        | `--output-format json`        | Scripts & CI — structured results as JSON on stdout, progress on stderr                |
| `stream-json` | `--output-format stream-json` | AI agents & streaming consumers — all events as NDJSON on stdout                       |

## stdout vs stderr

| Format        | stdout                                 | stderr                                                    |
| ------------- | -------------------------------------- | --------------------------------------------------------- |
| `text`        | everything (clack handles it)          | —                                                         |
| `json`        | structured results (`success`, `fail`) | progress logs (`info`, `warn`, `error`, `intro`, `outro`) |
| `stream-json` | everything as NDJSON events            | —                                                         |

## Service API

```ts
const output = yield* Output;

// Lifecycle
output.intro("Log in to Supabase")
output.outro("You are now logged in.")

// Progress logging
output.info("Connecting to server...")
output.warn("Token expires in 24 hours.")
output.error("Connection failed.")

// Interactive prompts (fail with NonInteractiveError in json/stream-json)
const name = yield* output.promptText("Enter your name", { validate: ... })
const pass = yield* output.promptPassword("Enter password")
const ok   = yield* output.promptConfirm("Continue?")

// Structured output
yield* output.success("Logged in successfully.", { command: "login", tokenName })
yield* output.fail({ code: "InvalidTokenError", message: "Bad token format" })
```

## How It Works

Each format has its own layer implementation. The root command provides the appropriate layer based on the `--output-format` flag:

```ts
// src/app.ts
Command.provide(({ outputFormat }) => {
  const base = Output.layerFor(outputFormat);
  if (outputFormat === "text") return base;
  return Layer.merge(base, CliOutput.layer(jsonCliOutputFormatter()));
});
```

Handlers only import `Output` — they never know which format is active:

```ts
// src/commands/login/login.handler.ts
export const login = (flags) =>
  Effect.gen(function* () {
    const output = yield* Output;
    // ... command logic ...
    yield* output.success("Logged in successfully.", { command: "login" });
  });
```

## Layer Behaviors

| Method                | text                     | json                                           | stream-json                                     |
| --------------------- | ------------------------ | ---------------------------------------------- | ----------------------------------------------- |
| `intro(title)`        | `clack.intro()`          | stderr: plain text                             | NDJSON `{type:"log",level:"info"}`              |
| `outro(msg)`          | `clack.outro()`          | stderr: plain text                             | NDJSON `{type:"log",level:"info"}`              |
| `info(msg)`           | `clack.log.info()`       | stderr: plain text                             | NDJSON `{type:"log",level:"info"}`              |
| `warn(msg)`           | `clack.log.warn()`       | stderr: plain text                             | NDJSON `{type:"log",level:"warn"}`              |
| `error(msg)`          | `clack.log.error()`      | stderr: plain text                             | NDJSON `{type:"log",level:"error"}`             |
| `promptText(...)`     | `clack.text()`           | `NonInteractiveError`                          | `NonInteractiveError`                           |
| `promptPassword(...)` | `clack.password()`       | `NonInteractiveError`                          | `NonInteractiveError`                           |
| `promptConfirm(...)`  | `clack.confirm()`        | `NonInteractiveError`                          | `NonInteractiveError`                           |
| `success(msg, data?)` | `clack.log.success(msg)` | stdout: `JSON.stringify({...data, message})`   | NDJSON `{type:"result",data:{...data,message}}` |
| `fail(err)`           | no-op                    | stdout: `JSON.stringify({_tag:"Error",error})` | NDJSON `{type:"error",error}`                   |

## Error Boundary

Each command wraps its handler with an error boundary that serializes domain errors in json/stream-json modes:

```ts
// src/commands/login/login.command.ts
Effect.catch((error) =>
  Effect.gen(function* () {
    const output = yield* Output;
    if (output.format === "text") return yield* Effect.fail(error);
    yield* output.fail({
      code: error._tag ?? "UnknownError",
      message: error.message,
    });
    process.exitCode = 1;
  }),
);
```

## Testing

Mock the Output service with `Layer.succeed(Output, { ... })`. Only override the methods you assert on:

```ts
function mockOutput(opts: { confirmRelogin?: boolean } = {}) {
  return Layer.succeed(Output, {
    format: "text" as const,
    intro: () => Effect.void,
    outro: () => Effect.void,
    info: () => Effect.void,
    warn: () => Effect.void,
    error: () => Effect.void,
    promptText: () => Effect.succeed("123456"),
    promptPassword: () => Effect.succeed(""),
    promptConfirm: () => Effect.succeed(opts.confirmRelogin ?? true),
    success: (_msg, _data?) => Effect.void,
    fail: () => Effect.void,
  });
}
```

## Future: Adopting More Clack Components

The `@clack/prompts` library offers many more components beyond what we currently wrap. Here's how they fit into our architecture.

### Easy additions (same pattern)

These follow the existing `(args) => Effect<T>` pattern and can be added as new methods on the Output service:

| Component         | Signature                                                             | json/stream-json behavior             |
| ----------------- | --------------------------------------------------------------------- | ------------------------------------- |
| `select<T>`       | `promptSelect(msg, options) => Effect<T, NonInteractiveError>`        | `NonInteractiveError` — use flags     |
| `multiselect<T>`  | `promptMultiSelect(msg, options) => Effect<T[], NonInteractiveError>` | `NonInteractiveError` — use flags     |
| `autocomplete<T>` | `promptAutocomplete(msg, options) => Effect<T, NonInteractiveError>`  | `NonInteractiveError` — use flags     |
| `note`            | `note(message, title?) => Effect<void>`                               | json: stderr, stream-json: NDJSON log |
| `box`             | `box(message, title?) => Effect<void>`                                | json: stderr, stream-json: NDJSON log |
| `log.step`        | `step(message) => Effect<void>`                                       | json: stderr, stream-json: NDJSON log |

### Design challenges: stateful components

Some Clack components return **handles with methods** rather than resolving to a single value. These don't fit our current fire-and-forget pattern.

#### `spinner`

Clack's `spinner()` returns `{ start(msg), stop(msg), message(msg), error(msg) }`. Two approaches:

**Option A — Wrapper function (simpler, covers most cases):**

```ts
yield * output.withSpinner("Deploying...", deployEffect);
// text: starts spinner, runs effect, stops spinner
// json: runs effect silently (or stderr status)
// stream-json: emits NDJSON progress events around effect
```

**Option B — Resource-based (more flexible):**

```ts
yield *
  Effect.scoped(
    Effect.gen(function* () {
      const spin = yield* output.spinner("Deploying...");
      yield* spin.message("Step 1...");
      yield* deploy();
      // spinner auto-stops when scope closes
    }),
  );
```

Option A is recommended as the starting point. Option B adds flexibility if commands need to update spinner messages mid-operation.

#### `progress`

Same challenge as spinner — returns a handle with `.advance()`, `.stop()`. Same solution: wrap with `withProgress(total, effect)` or use a resource-based approach.

#### `tasks`

Clack's `tasks()` takes an array of async functions and runs them sequentially with visual feedback. This is a higher-order component — it orchestrates multiple operations. In our model, this could become:

```ts
yield *
  output.withTasks([
    { title: "Installing deps", task: installEffect },
    { title: "Running migrations", task: migrateEffect },
  ]);
// text: clack tasks display
// json: runs silently, emits final result
// stream-json: emits NDJSON progress event per task
```

#### `taskLog`

Clearing log display with `.message()`, `.group()`, `.success()`, `.error()` methods. Similar to spinner — needs scoped resource pattern.

### Mock boilerplate growth

Every new method added to the Output service requires updating:

1. The service type definition
2. All 3 layer implementations (text, json, streamJson)
3. Every test mock

To mitigate this, consider creating a shared `defaultMockOutput()` factory that fills all fields with sensible defaults (no-ops for display, mock values for prompts). Tests then only override the specific methods they need to assert on:

```ts
function defaultMockOutput(overrides?: Partial<Output.Shape>): Layer.Layer<Output> {
  return Layer.succeed(Output, {
    format: "text" as const,
    intro: () => Effect.void,
    // ... all defaults ...
    ...overrides,
  });
}
```
