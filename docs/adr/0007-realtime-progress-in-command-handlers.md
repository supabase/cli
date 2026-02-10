# 0007. Real-time Progress in Command Handlers

**Status**: proposed
**Date**: 2026-02-10

## Problem Statement

[ADR 0001](0001-cli-dx-architecture-pillars.md) (Pillar 1: Command as Typed Function) establishes that handlers are pure functions returning `CommandResult<T>` — no `console.log`, no `process.exit`, no rendering. This works perfectly for simple request/response commands like `supa projects list`, but leaves a gap for long-running workflow commands (`supa dev`, `supa migrations push`) that need to communicate progress in real-time: loading config, starting containers, waiting for healthchecks, etc.

The simple `handler → CommandResult<T> → render` flow assumes the handler runs, finishes, and then the result is rendered. For workflow commands with multiple phases that take seconds or minutes, users (both humans and LLMs) need feedback _during_ execution, not just at the end.

Most commands don't need progress at all. Only workflow commands (`dev`, `push`, `pull`, `migrations push`) benefit from real-time feedback. This means we need two handler shapes, not one:

| Command type | Handler shape | Example |
|---|---|---|
| Simple (CRUD) | `async (flags) → CommandResult<T>` | `listProjects`, `createBranch` |
| Workflow | Yields events or calls a context — see patterns below | `runDev`, `pushMigrations` |

## Decision

We document two viable patterns — AsyncGenerator and Context Injection — with typed examples, trade-offs, and framework integrations. The recommendation is left open for team discussion during PR review.

Both patterns satisfy the core requirements:

- Handlers remain rendering-agnostic (no `console.log`, no framework imports)
- Progress events are typed and structured
- The same handler works with React-Ink, Clack, JSON/NDJSON, and tests
- Events map 1:1 to observability spans (Pillar 5)

### Shared Types

```typescript
type StepEvent = {
  type: "step";
  phase: string;
  status: "running" | "done" | "failed";
  message: string;
};

type CommandEvent<T> =
  | StepEvent
  | { type: "result"; data: CommandResult<T> };
```

### Pattern A — AsyncGenerator

The handler yields `CommandEvent<T>` events as it progresses through phases, then yields the final result. The handler is fully pure — it yields data and never calls external APIs for rendering.

**Handler**:

```typescript
async function* runDev(flags: DevFlags): AsyncGenerator<CommandEvent<DevOutput>> {
  yield { type: "step", phase: "config", status: "running", message: "Loading config..." };
  const config = await loadConfig();
  yield { type: "step", phase: "config", status: "done", message: "Loaded config" };

  yield { type: "step", phase: "docker", status: "running", message: "Starting containers..." };
  await startContainers(config);
  yield { type: "step", phase: "docker", status: "done", message: "Containers started" };

  yield { type: "step", phase: "health", status: "running", message: "Waiting for healthcheck..." };
  await waitForHealthy();
  yield { type: "step", phase: "health", status: "done", message: "All services healthy" };

  yield {
    type: "result",
    data: { ok: true, data: { port: 54322, services: ["postgres", "postgrest", "gotrue"] } },
  };
}
```

**React-Ink renderer**:

```tsx
import { render, Text, Box } from "ink";
import Spinner from "ink-spinner";

function StepLine({ step }: { step: StepEvent }) {
  return (
    <Box gap={1}>
      {step.status === "running" && <Spinner type="dots" />}
      {step.status === "done" && <Text color="green">✓</Text>}
      {step.status === "failed" && <Text color="red">✗</Text>}
      <Text dimColor={step.status === "done"}>{step.message}</Text>
    </Box>
  );
}

function DevUI({ flags }: { flags: DevFlags }) {
  const [steps, setSteps] = useState<Map<string, StepEvent>>(new Map());
  const [result, setResult] = useState<CommandResult<DevOutput> | null>(null);

  useEffect(() => {
    const run = async () => {
      for await (const event of runDev(flags)) {
        if (event.type === "step") {
          setSteps((prev) => new Map(prev).set(event.phase, event));
        } else {
          setResult(event.data);
        }
      }
    };
    run();
  }, []);

  return (
    <Box flexDirection="column">
      {[...steps.values()].map((step) => (
        <StepLine key={step.phase} step={step} />
      ))}
      {result?.ok && (
        <Box marginTop={1}>
          <Text dimColor>Ready on localhost:{result.data.port}</Text>
        </Box>
      )}
    </Box>
  );
}

render(<DevUI flags={parsedFlags} />);
```

Terminal output evolves in real-time:

```
⠋ Loading config...
```

then:

```
✓ Loaded config
⠋ Starting containers...
```

then:

```
✓ Loaded config
✓ Containers started
✓ All services healthy

Ready on localhost:54322
```

**Clack renderer**:

```typescript
import * as p from "@clack/prompts";

async function renderDev(flags: DevFlags) {
  p.intro("supa dev");

  const s = p.spinner();

  for await (const event of runDev(flags)) {
    if (event.type === "step") {
      if (event.status === "running") {
        s.start(event.message);
      } else if (event.status === "done") {
        s.stop(event.message);
      } else {
        s.stop(`Failed: ${event.message}`, 1);
      }
    } else if (event.type === "result" && event.data.ok) {
      p.outro(`Ready on localhost:${event.data.data.port}`);
    }
  }
}
```

**JSON/NDJSON renderer** (non-TTY / LLM mode):

```typescript
async function renderJson<T>(gen: AsyncGenerator<CommandEvent<T>>) {
  for await (const event of gen) {
    process.stdout.write(JSON.stringify(event) + "\n");
  }
}
```

Output (NDJSON — one event per line):

```json
{"type":"step","phase":"config","status":"running","message":"Loading config..."}
{"type":"step","phase":"config","status":"done","message":"Loaded config"}
{"type":"step","phase":"docker","status":"running","message":"Starting containers..."}
{"type":"step","phase":"docker","status":"done","message":"Containers started"}
{"type":"step","phase":"health","status":"running","message":"Waiting for healthcheck..."}
{"type":"step","phase":"health","status":"done","message":"All services healthy"}
{"type":"result","data":{"ok":true,"data":{"port":54322,"services":["postgres","postgrest","gotrue"]}}}
```

**Test code**:

```typescript
test("runDev emits correct phase sequence", async () => {
  const events: CommandEvent<DevOutput>[] = [];
  for await (const event of runDev(testFlags)) {
    events.push(event);
  }

  expect(events).toMatchObject([
    { type: "step", phase: "config", status: "running" },
    { type: "step", phase: "config", status: "done" },
    { type: "step", phase: "docker", status: "running" },
    { type: "step", phase: "docker", status: "done" },
    { type: "step", phase: "health", status: "running" },
    { type: "step", phase: "health", status: "done" },
    { type: "result", data: { ok: true } },
  ]);
});
```

### Pattern B — Context Injection

The handler receives a `CommandContext` interface and calls methods to report progress. The handler returns a standard `Promise<CommandResult<T>>` — the same return type as simple commands.

**Interface**:

```typescript
interface CommandContext {
  step(phase: string, message: string): void;
  done(phase: string, message: string): void;
  fail(phase: string, message: string): void;
}
```

**Handler**:

```typescript
async function runDev(flags: DevFlags, ctx: CommandContext): Promise<CommandResult<DevOutput>> {
  ctx.step("config", "Loading config...");
  const config = await loadConfig();
  ctx.done("config", "Loaded config");

  ctx.step("docker", "Starting containers...");
  await startContainers(config);
  ctx.done("docker", "Containers started");

  ctx.step("health", "Waiting for healthcheck...");
  await waitForHealthy();
  ctx.done("health", "All services healthy");

  return { ok: true, data: { port: 54322, services: ["postgres", "postgrest", "gotrue"] } };
}
```

**React-Ink renderer**:

```tsx
import { render, Text, Box } from "ink";
import Spinner from "ink-spinner";

function DevUI({ flags }: { flags: DevFlags }) {
  const [steps, setSteps] = useState<Map<string, StepEvent>>(new Map());
  const [result, setResult] = useState<CommandResult<DevOutput> | null>(null);

  const ctx: CommandContext = useMemo(
    () => ({
      step(phase, message) {
        setSteps((prev) => new Map(prev).set(phase, { phase, status: "running", message }));
      },
      done(phase, message) {
        setSteps((prev) => new Map(prev).set(phase, { phase, status: "done", message }));
      },
      fail(phase, message) {
        setSteps((prev) => new Map(prev).set(phase, { phase, status: "failed", message }));
      },
    }),
    [],
  );

  useEffect(() => {
    runDev(flags, ctx).then(setResult);
  }, []);

  return (
    <Box flexDirection="column">
      {[...steps.values()].map((step) => (
        <StepLine key={step.phase} step={step} />
      ))}
      {result?.ok && (
        <Box marginTop={1}>
          <Text dimColor>Ready on localhost:{result.data.port}</Text>
        </Box>
      )}
    </Box>
  );
}
```

**Clack renderer**:

```typescript
import * as p from "@clack/prompts";

function createClackContext(): CommandContext {
  const s = p.spinner();
  return {
    step(_phase, message) {
      s.start(message);
    },
    done(_phase, message) {
      s.stop(message);
    },
    fail(_phase, message) {
      s.stop(`Failed: ${message}`, 1);
    },
  };
}

async function renderDev(flags: DevFlags) {
  p.intro("supa dev");
  const ctx = createClackContext();
  const result = await runDev(flags, ctx);
  if (result.ok) {
    p.outro(`Ready on localhost:${result.data.port}`);
  }
}
```

**JSON/NDJSON renderer** (non-TTY / LLM mode):

```typescript
function createJsonContext(): CommandContext {
  return {
    step(phase, message) {
      process.stdout.write(JSON.stringify({ type: "step", phase, status: "running", message }) + "\n");
    },
    done(phase, message) {
      process.stdout.write(JSON.stringify({ type: "step", phase, status: "done", message }) + "\n");
    },
    fail(phase, message) {
      process.stdout.write(JSON.stringify({ type: "step", phase, status: "failed", message }) + "\n");
    },
  };
}
```

**Test code**:

```typescript
test("runDev reports correct phases", async () => {
  const events: Array<{ phase: string; status: string; message: string }> = [];
  const ctx: CommandContext = {
    step(phase, msg) { events.push({ phase, status: "running", message: msg }); },
    done(phase, msg) { events.push({ phase, status: "done", message: msg }); },
    fail(phase, msg) { events.push({ phase, status: "failed", message: msg }); },
  };

  const result = await runDev(testFlags, ctx);

  expect(result.ok).toBe(true);
  expect(events[0]).toMatchObject({ phase: "config", status: "running" });
  expect(events[1]).toMatchObject({ phase: "config", status: "done" });
});
```

## Rationale

### Trade-off Comparison

| Dimension | AsyncGenerator | Context Injection |
|---|---|---|
| Handler purity | Fully pure — yields data, no callbacks | Almost pure — calls an injected interface |
| With React-Ink | Works, but needs `for await` → `setState` bridge | Very natural — callbacks map directly to `setState` |
| With Clack | Very natural — imperative loop matches imperative API | Natural — adapter wraps Clack's spinner |
| Handler signature | Different from simple commands (`AsyncGenerator` vs `Promise`) | Same return type (`Promise<CommandResult<T>>`), extra param |
| Backpressure | Built-in — generator pauses until consumer is ready | None — fire and forget |
| Testing | Collect and assert on array of events | Spy on context methods |

### Observability Integration

Both patterns map 1:1 to trace spans from Pillar 5 (ADR 0001). Each `step`/`done` pair _is_ a span:

```
supa dev (total: 1.2s)
├── config: 12ms       ← step → done
├── docker: 890ms      ← step → done
└── health: 230ms      ← step → done
```

Progress events and observability come from the same mechanism — you get instrumentation for free.

### Open Question

Which pattern should we adopt as the standard?

- **Context Injection** pairs better with React-Ink (callbacks are React's native language) and keeps handler return types consistent (`Promise<CommandResult<T>>` for both simple and workflow commands).
- **AsyncGenerator** is more purely functional with built-in backpressure and pairs naturally with Clack's imperative API.

This is left for team discussion during PR review.

## Consequences

### Positive

- Long-running commands can report real-time progress without breaking the handler purity model
- Both humans (spinners/checkmarks) and LLMs (streaming NDJSON) get appropriate real-time feedback
- Progress events map 1:1 to observability spans — instrumentation is a free side effect
- Handlers remain rendering-agnostic — the same handler works with React-Ink, Clack, JSON, and tests
- Simple commands are unaffected — only workflow commands opt into the progress pattern

### Negative

- Two handler shapes means more complexity in the type system and command registration
- AsyncGenerator requires a bridge layer for React-Ink; Context Injection is slightly impure
- Renderers must handle both simple results and streaming events
- NDJSON output is a different contract than single-object JSON — consumers need to know which to expect

## Alternatives Considered

1. **No progress — just return the final result**: Works for CRUD commands but creates a poor experience for `supa dev` where users stare at a blank terminal for seconds. Unacceptable for workflow commands.

2. **Console.log inside handlers**: Violates Pillar 1 entirely. Makes handlers untestable, couples them to terminal output, and breaks JSON/NDJSON output for LLMs.

3. **EventEmitter pattern**: Handlers emit events via an injected EventEmitter. Similar to Context Injection but with more indirection, weaker typing, and harder-to-follow control flow. The explicit interface is simpler.

4. **RxJS / Observable pattern**: Full reactive streams with operators. Massive overkill for step-based progress reporting. Adds a large dependency for no practical benefit over generators or callbacks.

## Related Decisions

- [ADR 0001](0001-cli-dx-architecture-pillars.md): CLI DX Architecture — Pillar 1 (Command as Typed Function), Pillar 3 (Output Design), Pillar 5 (Observability)
- [ADR 0002](0002-cli-product-metrics.md): CLI Product Metrics — progress events map to telemetry spans
- [ADR 0004](0004-cli-design-goals-and-workflows.md): CLI Design Goals — defines `supa dev` as the primary orchestrator and the workflow commands that need real-time progress
