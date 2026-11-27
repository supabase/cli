# Terminal UI

The CLI's terminal design system lives in `src/ui/`. It builds on
[`@supabase/ui-terminal`](../../../packages/ui-terminal/README.md), a host for
[Effect UI](https://github.com/Effect-TS/ui) components that renders inline below the cursor.

No command renders through it yet. The `text` output format still uses `@clack/prompts` through
the [`Output` service](../../../docs/output.md).

## Layers

| Layer                   | Owns                                                                                                   |
| ----------------------- | ------------------------------------------------------------------------------------------------------ |
| `@effect/ui`            | The component model: schema props, model, messages, `update`, `view`, commands and subscriptions.      |
| `@supabase/ui-terminal` | Primitives only: the `box`, `static` and `text` elements, `run`, keys, semantic tones, and test tools. |
| `apps/cli/src/ui`       | The Supabase look: theme, glyphs, blocks, prompts and the gallery.                                     |

The host stays brand-free. A missing primitive, such as text input or scrolling, goes into
`packages/ui-terminal`; anything with a Supabase look goes into `src/ui`.

| File         | Contents                                                                   |
| ------------ | -------------------------------------------------------------------------- |
| `theme.ts`   | `supabaseTheme`: each tone as truecolor, 256-color and 16-color values.    |
| `glyphs.ts`  | Symbols with their ASCII stand-ins, and the spinner frames.                |
| `blocks.ts`  | `Spinner`, `Select` and `KeyValue`.                                        |
| `prompt.ts`  | `select`, which runs a `Select` inline and resolves with the chosen value. |
| `gallery.ts` | Every block on one screen, under the Supabase theme.                       |

## Gallery

From `apps/cli`:

```sh
pnpm ui:gallery
```

It needs a real terminal. Set `NO_COLOR=1`, `FORCE_COLOR=1` (16 colors) or `FORCE_COLOR=2`
(256 colors) to check the fallbacks, and `LANG=C` to check the ASCII glyphs.

## Writing a block

- Color through tones (`tone: "accent"`), never color values. The theme maps tones to colors, and
  the host lowers them to the terminal's color depth or drops them under `NO_COLOR`.
- Add each new symbol to `glyphs.ts` with an ASCII stand-in, and take a `unicode` prop filled
  from `terminal.capabilities.unicode`.
- A block with state or input is a `Terminal.component` with schema props. A stateless layout,
  like `KeyValue`, is a view function that takes `h`.
- A block reports outcomes as typed events, as `Select` emits `Submitted`. The root that owns the
  run, such as the prompt in `prompt.ts`, maps them to messages and ends the run with
  `TerminalCommand.finish()`.
- Put output that never changes under `static`: it is written to the scrollback once. Keep the
  live region small, since it is redrawn on every change.
- Without a TTY, or with `TERM=dumb`, a run fails with `NonInteractive` before writing anything.
  Every interactive path needs a flag or `--output-format json` equivalent.

## Testing

Blocks are tested through integration tests that render on a headless xterm with `TerminalTest`
from `@supabase/ui-terminal/testing`, then assert on the screen rows, the scrollback and the
cursor. See `src/ui/blocks.integration.test.ts` and `src/ui/prompt.integration.test.ts`.

```sh
pnpm test:integration src/ui
```
