# UI Architecture: Effect + React (ink) for Terminal UIs

## Background

This document captures findings from studying [cheffect](https://github.com/tim-smart/cheffect) (a web app by Tim Smart, Effect core maintainer) and the Effect V4 reactive primitives. The goal: understand how to plug React into an Effect codebase for rich terminal UIs via [ink](https://github.com/vadimdemedes/ink).

### Reference Code

| Location                                                 | Description                                     |
| -------------------------------------------------------- | ----------------------------------------------- |
| `.repos/cheffect/`                                       | Tim Smart's web app using Effect + React + Atom |
| `.repos/effect/packages/effect/src/unstable/reactivity/` | Effect V4 core reactive primitives              |
| `.repos/effect/packages/atom/react/`                     | Official React bindings for Effect Atom         |

## Core Primitive: `Atom`

**Import:** `import * as Atom from "effect/unstable/reactivity/Atom"`

An `Atom` is Effect's reactive state container. It's framework-agnostic — React bindings are layered on top.

### Creating Atoms

```ts
import * as Atom from "effect/unstable/reactivity/Atom";
import * as Effect from "effect/Effect";

// Simple writable state
const countAtom = Atom.make(0);

// Computed (read-only, derived from other atoms)
const doubleAtom = Atom.make((get) => get(countAtom) * 2);

// With side effects and cleanup (from cheffect's atoms.ts)
const nowAtom = Atom.make((get) => {
  const handle = setInterval(() => {
    get.setSelf(DateTime.unsafeNow());
  }, 250);
  get.addFinalizer(() => clearInterval(handle));
  return DateTime.unsafeNow();
});

// Wrapping an Effect (returns AsyncResult)
const dataAtom = Atom.make(Effect.promise(() => fetch("/api/data").then((r) => r.json())));

// Wrapping a Stream (returns AsyncResult, updates on each emission)
const stateAtom = Atom.make(someStream);
```

### Key `Atom` Types

```ts
interface Atom<A> {
  readonly read: (get: Context) => A;
  readonly keepAlive: boolean;
  readonly lazy: boolean;
  readonly label?: readonly [name: string, stack: string];
  readonly idleTTL?: number;
}

interface Writable<R, W = R> extends Atom<R> {
  readonly write: (ctx: WriteContext<R>, value: W) => void;
}
```

### Context (the `get` parameter)

Inside `Atom.make((get) => ...)`, the `get` context provides:

- `get(otherAtom)` — read another atom (creates dependency)
- `get.setSelf(value)` — update this atom's value
- `get.addFinalizer(fn)` — cleanup when atom unmounts
- `get.stream(atom)` — get a `Stream<A>` from another atom

## AtomRegistry: The State Container

**Import:** `import * as AtomRegistry from "effect/unstable/reactivity/AtomRegistry"`

The registry is the centralized store that holds all atom values and manages the dependency graph.

```ts
const registry = AtomRegistry.make({
  scheduleTask: (f) => {
    /* schedule re-evaluation */
  },
  defaultIdleTTL: 400, // ms before GC of idle atoms
  initialValues: [[countAtom, 42]], // optional initial overrides
});

// Core operations
registry.get(atom); // Read current value
registry.set(atom, value); // Write + notify subscribers
registry.subscribe(atom, callback); // Listen for changes → () => void (unsubscribe)
registry.mount(atom); // Initialize atom (trigger read, setup side effects)
registry.refresh(atom); // Force re-compute
registry.dispose(); // Cleanup everything
```

## React Bindings: `@effect/atom-react`

**Import:** `import { useAtomValue, useAtom, useAtomSet, RegistryProvider } from "@effect/atom-react"`

**Package:** `.repos/effect/packages/atom/react/` (V4), `@effect-atom/atom-react` on npm (V3)

**Peer deps:** `effect`, `react ^19.2.4`, `scheduler`

### How It Works

The bridge is simple — `useSyncExternalStore` connects React's render cycle to the registry's subscribe/get:

```ts
// From .repos/effect/packages/atom/react/src/Hooks.ts
function useStore<A>(registry: AtomRegistry.AtomRegistry, atom: Atom.Atom<A>): A {
  const store = makeStore(registry, atom);
  return React.useSyncExternalStore(
    store.subscribe, // registry.subscribe(atom, callback)
    store.snapshot, // registry.get(atom)
    store.getServerSnapshot,
  );
}
```

### Provider Setup

```tsx
import { RegistryProvider } from "@effect/atom-react";

function App() {
  return (
    <RegistryProvider initialValues={[[countAtom, 0]]} defaultIdleTTL={400}>
      <MyComponent />
    </RegistryProvider>
  );
}
```

The provider creates one `AtomRegistry` per mount, stored in a `useRef`. On unmount, it disposes after a 500ms timeout.

### Hooks

| Hook                        | Purpose                                    | Signature                               |
| --------------------------- | ------------------------------------------ | --------------------------------------- |
| `useAtomValue(atom)`        | Read atom value, re-render on change       | `Atom<A> → A`                           |
| `useAtomValue(atom, f)`     | Read + transform                           | `Atom<A>, (A → B) → B`                  |
| `useAtomSet(atom)`          | Get setter function                        | `Writable<R,W> → (W) → void`            |
| `useAtom(atom)`             | Read + write tuple                         | `Writable<R,W> → [R, (W) → void]`       |
| `useAtomMount(atom)`        | Manually mount atom (trigger side effects) | `Atom<A> → void`                        |
| `useAtomRefresh(atom)`      | Get refresh function                       | `Atom<A> → () → void`                   |
| `useAtomSuspense(atom)`     | Read async atom with React Suspense        | `Atom<AsyncResult<A,E>> → Success<A,E>` |
| `useAtomSubscribe(atom, f)` | Side-effect on changes (no re-render)      | `Atom<A>, (A → void) → void`            |
| `useAtomRef(ref)`           | Track an `AtomRef`                         | `ReadonlyRef<A> → A`                    |

### Usage Patterns (from cheffect)

```tsx
// Read-only (re-renders when atom changes)
const isOpen = useAtomValue(aiChatOpenAtom);

// Read + write
const [isOpen, setIsOpen] = useAtom(aiChatOpenAtom);

// Mount atom to trigger side effects (no value needed)
useAtomMount(installPromptAtom);

// Subscribe without re-rendering
useAtomSubscribe(dataAtom, (value) => {
  console.log("changed:", value);
});
```

## AsyncResult: Async State Handling

**Import:** `import * as AsyncResult from "effect/unstable/reactivity/AsyncResult"`

When an atom wraps an `Effect` or `Stream`, its value is `AsyncResult<A, E>`:

```ts
type AsyncResult<A, E> =
  | Initial<A, E> // Effect hasn't resolved yet
  | Success<A, E> // Has value
  | Failure<A, E>; // Has error

// Properties on all variants:
//   _tag: "Initial" | "Success" | "Failure"
//   waiting: boolean (optimistic update in progress)
//   value / cause (on Success / Failure)
```

Pattern matching:

```tsx
const result = useAtomValue(asyncAtom);

AsyncResult.match(result, {
  onInitial: () => <Text>Loading...</Text>,
  onSuccess: ({ value }) => <Text>{value}</Text>,
  onFailure: ({ cause }) => <Text color="red">Error</Text>,
});
```

Or with Suspense (throws promise while loading):

```tsx
function DataComponent() {
  const result = useAtomSuspense(asyncAtom);
  // result is always Success here (Initial throws, Failure throws by default)
  return <Text>{result.value}</Text>;
}
```

## Application to CLI: Effect + ink + Atom

### Architecture

```
┌─────────────────────────────────────────────┐
│ Effect Runtime                               │
│  ┌─────────┐  ┌──────────────────────────┐ │
│  │ Stack   │  │ attached session         │ │
│  │ service │──│ creates model + registry │ │
│  │         │  │ starts stack             │ │
│  │         │  │ streams state changes    │ │
│  └─────────┘  └───────────┬──────────────┘ │
│                            │ AtomRegistry   │
│  ┌─────────────────────────┼──────────────┐ │
│  │ ink (React renderer)    │              │ │
│  │  ┌─────────────────────┐│              │ │
│  │  │ RegistryContext     ││              │ │
│  │  │  ┌──────────────┐  ││              │ │
│  │  │  │ Dashboard    │  ││              │ │
│  │  │  │ useAtomValue │◄─┘              │ │
│  │  │  │ (reads only) │                 │ │
│  │  │  └──────────────┘                 │ │
│  │  └───────────────────────────────────┘ │
│  └────────────────────────────────────────┘ │
└─────────────────────────────────────────────┘
```

### Data Flow

1. **Effect side** creates a session-scoped dashboard model and a manual `AtomRegistry`
2. **Effect side** snapshots `stack.getInfo()` / `stack.getAllStates()` into writable atoms
3. **Effect side** forks a supervised child fiber that pipes `stack.allStateChanges()` into the registry
4. **ink side** renders `RegistryContext.Provider` with the shared registry
5. **React components** use `useAtomValue()` to subscribe and render only
6. **Effect side** controls lifecycle: render → `stack.start()` → wait for exit → stop stack → dispose registry

### Atoms for the Start Command

```ts
import * as Atom from "effect/unstable/reactivity/Atom";
import type { StackServiceState } from "@supabase/stack";
import type { StackInfo } from "@supabase/stack/internals";

export type StartPhase = "starting" | "running" | "failed" | "stopping";

export function createDashboardModel() {
  const serviceStatesAtom = Atom.make<ReadonlyArray<StackServiceState>>([]);
  const stackInfoAtom = Atom.make<StackInfo | null>(null);
  const phaseAtom = Atom.make<StartPhase>("starting");
  const errorAtom = Atom.make<string | null>(null);

  const displayStatesAtom = Atom.make((get) => get(serviceStatesAtom));
  const allHealthyAtom = Atom.make(
    (get) =>
      get(displayStatesAtom).length > 0 &&
      get(displayStatesAtom).every((s) => s.status === "Healthy"),
  );
  const statusLineAtom = Atom.make((get) => {
    const phase = get(phaseAtom);
    if (phase === "failed") return `❌ ${get(errorAtom) ?? "Startup failed"}`;
    if (phase === "stopping") return "⏳ Stopping...";
    if (phase === "running") return "🟢 Running — Press Ctrl+C to stop";
    return get(allHealthyAtom) ? "🟢 Running — Press Ctrl+C to stop" : "⏳ Starting...";
  });

  return {
    serviceStatesAtom,
    stackInfoAtom,
    phaseAtom,
    errorAtom,
    displayStatesAtom,
    allHealthyAtom,
    statusLineAtom,
  };
}
```

### Handler Pattern

```ts
import * as AtomRegistry from "effect/unstable/reactivity/AtomRegistry"
import { Cause, Effect, Fiber, Stream } from "effect"

const startAttached = Effect.fnUntraced(function* () {
  const stack = yield* Stack
  const ink = yield* Ink
  const info = yield* stack.getInfo()
  const initialStates = yield* stack.getAllStates()
  const model = createDashboardModel()

  // Create registry (shared between Effect and React for this one session)
  const registry = AtomRegistry.make({ scheduleTask: (f) => { f(); return () => {} } })
  registry.set(model.stackInfoAtom, info)
  registry.set(model.serviceStatesAtom, initialStates)

  // Fork: pipe state changes into writable atoms
  const fiber = yield* Stream.runForEach(
    stack.allStateChanges(),
    (state) => Effect.sync(() => {
      const current = registry.get(model.serviceStatesAtom)
      registry.set(model.serviceStatesAtom,
        current.map((s) => s.name === state.name ? state : s)
      )
    }),
  ).pipe(Effect.forkChild({ startImmediately: true }))

  // Render the dashboard before startup finishes
  const instance = yield* ink.render(
    <RegistryContext.Provider value={registry}>
      <StartDashboard model={model} />
    </RegistryContext.Provider>
  )

  return yield* Effect.gen(function* () {
    yield* stack.start()
    registry.set(model.phaseAtom, "running")
    yield* Effect.promise(() => instance.waitUntilExit())
    registry.set(model.phaseAtom, "stopping")
  }).pipe(
    Effect.catchCause((cause) =>
      Effect.sync(() => {
        registry.set(model.errorAtom, Cause.pretty(cause))
        registry.set(model.phaseAtom, "failed")
      }).pipe(Effect.zipRight(Effect.failCause(cause)))
    ),
    Effect.ensuring(
      Effect.gen(function* () {
        yield* Fiber.interrupt(fiber)
        instance.unmount()
        yield* stack.stop()
        registry.dispose()
      })
    )
  )
})
```

### Component Pattern

```tsx
import { useAtomValue } from "@effect/atom-react";
import { Box, Text } from "ink";
import Spinner from "ink-spinner";
import type { DashboardModel } from "./atoms";

function StartDashboard({ model }: { model: DashboardModel }) {
  const states = useAtomValue(model.displayStatesAtom);
  const info = useAtomValue(model.stackInfoAtom);
  const phase = useAtomValue(model.phaseAtom);
  const showConnectionInfo =
    useAtomValue(model.allHealthyAtom) && info !== null && phase !== "failed";
  const statusLine = useAtomValue(model.statusLineAtom);

  return (
    <StartDashboardView
      states={states}
      info={info}
      showConnectionInfo={showConnectionInfo}
      phase={phase}
      statusLine={statusLine}
    />
  );
}

function StartDashboardView(props: {
  states: ReadonlyArray<ServiceState>;
  info: StackInfo | null;
  showConnectionInfo: boolean;
  phase: StartPhase;
  statusLine: string;
}) {
  return (
    <Box flexDirection="column" paddingLeft={1}>
      <Text bold>🚀 Supabase</Text>
      <Text> </Text>
      <ServiceTable states={props.states} />
      {props.showConnectionInfo && props.info !== null && <ConnectionInfo info={props.info} />}
      <Text> </Text>
      {props.phase === "failed" ? (
        <Text color="red">{props.statusLine}</Text>
      ) : (
        <Text dimColor>{props.statusLine}</Text>
      )}
    </Box>
  );
}
```

## Other Effect Reactive Primitives

For reference, Effect V4 provides several reactive primitives beyond Atom:

| Primitive         | Location                                  | Use Case                                           |
| ----------------- | ----------------------------------------- | -------------------------------------------------- |
| `Atom`            | `effect/unstable/reactivity/Atom`         | Framework-integrated reactive state                |
| `AtomRef`         | `effect/unstable/reactivity/AtomRef`      | Lightweight synchronous reactive ref               |
| `AtomRegistry`    | `effect/unstable/reactivity/AtomRegistry` | Centralized atom state container                   |
| `AsyncResult`     | `effect/unstable/reactivity/AsyncResult`  | Loading/success/failure state for async atoms      |
| `SubscriptionRef` | `effect/SubscriptionRef`                  | Mutable ref + PubSub (Effect-native, no framework) |
| `PubSub`          | `effect/PubSub`                           | Message broadcast hub                              |
| `Ref`             | `effect/Ref`                              | Basic mutable reference                            |

**For React integration, `Atom` + `@effect/atom-react` is the recommended approach** — it's what the Effect team uses (see cheffect).

## Key Differences: cheffect (V3) vs Our CLI (V4)

| Aspect         | cheffect                           | Our CLI                                                                 |
| -------------- | ---------------------------------- | ----------------------------------------------------------------------- |
| Effect version | V3 (`^3.19.19`)                    | V4 (from `.repos/effect/`)                                              |
| React version  | 19.x                               | 19.x (ink latest requires >=19)                                         |
| Renderer       | react-dom (web)                    | ink (terminal)                                                          |
| Atom import    | `@effect-atom/atom-react` (npm V3) | `@effect/atom-react` or local from `.repos/effect/packages/atom/react/` |
| Atom core      | `@effect-atom/atom` (npm V3)       | `effect/unstable/reactivity/Atom` (built into effect V4)                |

In V4, Atom is built into the core `effect` package under `unstable/reactivity/`. The React bindings are in the separate `@effect/atom-react` package.

## Dependencies Required

```json
{
  "dependencies": {
    "ink": "^5.x",
    "react": "^19.2.4",
    "ink-spinner": "^5.x",
    "scheduler": "^0.27.0"
  },
  "devDependencies": {
    "@types/react": "^19.x",
    "ink-testing-library": "^4.x"
  }
}
```

Note: `@effect/atom-react` can be consumed directly from `.repos/effect/packages/atom/react/src/` (since we already use the local Effect V4 source), or published as a workspace package.
