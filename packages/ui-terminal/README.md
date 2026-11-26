# @supabase/ui-terminal

A brand-neutral terminal host for [Effect UI](https://github.com/Effect-TS/ui). It renders a
component inline below the cursor, lays it out with Yoga, and runs unchanged on Node and Bun. It is
laid out like `@effect/ui-opentui`, so modules and names carry over.

`@effect/ui` is pinned to a pre-release snapshot in `package.json`; replace it with the npm release
once one is published.

## Example

```ts
import { UiSchema } from "@effect/ui";
import { Effect, Schema } from "effect";
import {
  Terminal,
  TerminalCommand,
  TerminalHost,
  TerminalSubscription,
} from "@supabase/ui-terminal";

const Message = UiSchema.TaggedEnum({ Up: {}, Done: {} });

const Counter = Terminal.component({
  name: "Counter",
  model: Schema.Struct({ count: Schema.Number }),
  message: Message,
}).make({
  init: () => ({ count: 0 }),
  update: {
    Up: ($) => $.evolve({ count: (n) => n + 1 }),
    Done: ($) => $.run(TerminalCommand.finish()),
  },
  subscriptions: () => [
    TerminalSubscription.shortcuts([
      { key: "up", message: Message.Up() },
      { key: "return", message: Message.Done() },
    ]),
  ],
  view: (h, model) => h.text.style({ tone: "accent" }).children(`count ${model.count}`),
});

const program = TerminalHost.run(Counter, {}).pipe(
  Effect.tap((model) => Effect.log(`final count: ${model?.count}`)),
  Effect.provide(TerminalHost.layerProcess),
);
```

`run` resolves with the root's model once the component issues `TerminalCommand.finish()`. Ctrl+C
interrupts the fiber that opened the session, on `run` and `mountEffect` alike. Either way
the final frame stays in the scrollback, the cursor lands below it and the terminal is restored.
`mountEffect` returns a handle whose `finished` effect resolves with the model at `finish`.

## Signals

The embedding app owns signals; the package installs no handlers. `run` and `mountEffect` restore the
terminal when their fiber is interrupted, and the CLI's global handler interrupts the command fiber
on SIGINT, SIGTERM and SIGHUP.

## Modules

| Module                 | Purpose                                                                                   |
| ---------------------- | ----------------------------------------------------------------------------------------- |
| `Terminal`             | The `box`, `static` and `text` elements, `component`, and the host service.               |
| `TerminalHost`         | `run` and `mountEffect`, plus the process transport and its errors.                       |
| `TerminalCommand`      | `finish`, which ends a run.                                                               |
| `TerminalSubscription` | `onKeyPress`, `onResize` and `shortcuts`.                                                 |
| `TerminalKeyboard`     | The pure `shortcuts` key matcher behind the subscription.                                 |
| `TerminalTheme`        | Tones (`default`, `muted`, `accent`, `success`, `warning`, `danger`, `info`) and themes.  |
| `testing`              | `TerminalTest` and `TestTerminalEvents`, importable from `@supabase/ui-terminal/testing`. |

Tones are semantic. The default theme uses the terminal's own 16-color palette; provide another
with `TerminalTheme.layer(spec)` or the `renderer.theme` mount option.

The testing entry runs the production decoder and writer against `@xterm/headless`, so tests
assert on the rendered screen, the scrollback, the cursor and the raw-mode transitions without a
native library or a real terminal.

## Environment

`NO_COLOR`, `FORCE_COLOR`, `TERM`, `COLORTERM`, `COLUMNS`, `LINES` and the locale variables are read
once by `TerminalHost.layerProcess` through Effect `Config`, so a `ConfigProvider` can replace them.
Without a TTY on both ends, or with `TERM=dumb`, `run` fails with `NonInteractive` before writing
any byte.

## Differences from `@effect/ui-opentui`

- The live region is as tall as its content, and the final frame stays in the scrollback.
- `static` elements write their children to the scrollback once and never redraw them.
- `run` returns the root model and ends on `TerminalCommand.finish` rather than `quit`.
- There is no Layer `mount`: a layer's build fiber cannot own the session's Ctrl+C or finish.
- A view error fails the run instead of being logged.
- Output follows `NO_COLOR` and `TERM=dumb`, and a run never writes escape sequences into a pipe.
- There is no native dependency; layout is Yoga's WebAssembly build.
- Not implemented yet: `ref`, `Measure`, key-release events, `EventOptions` on `shortcuts`, text
  input, scrolling, the alternate screen, `onMount` (`runsMounts` is false) and `keepAlive`.
- Bracketed paste is not enabled, so a multi-line paste arrives as keystrokes.
- Width is a grapheme-cluster heuristic, not a terminal query: a cluster is as wide as its first
  visible code point, or 2 cells for emoji presentation, so terminals that disagree can drift.
