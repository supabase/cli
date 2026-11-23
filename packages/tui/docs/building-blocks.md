# Building blocks

Building blocks are the reusable pieces of terminal UI: a spinner, a select, a key-value list.
They are plain [Foldkit](https://foldkit.dev) modules, imported as namespaces
(`import * as Select from "./select.ts"`). The one substitution is the view target: views return a
`View.Node` (exported from [`view/public.ts`](../src/view/public.ts)) instead of `Html`. Blocks
import the renderer only through its `public.ts` barrels.

## Stateless helper or submodel

| Shape            | Choose it when                                                                                            | Example                                                                          |
| ---------------- | --------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| Stateless helper | The output is a pure function of its inputs and the parent already owns every value it shows.             | [`key-value.ts`](../src/blocks/key-value.ts)                                     |
| Submodel         | The block keeps state of its own (a highlight, a frame counter), reacts to keys, or owns an event source. | [`select.ts`](../src/blocks/select.ts), [`spinner.ts`](../src/blocks/spinner.ts) |

A stateless helper exports `view(config) => Node` and nothing else. Prefer it until the block needs
state the parent should not carry. Like a submodel's `viewInputs`, its config carries parent state:
`KeyValue.view({ entries, tone? })` takes no width. The key column is half the block, at most the
widest key (by rendered width) and at most 24 cells, so the block sizes itself from the space its parent gives it and values keep room on a
narrow pane. It fills its parent, and because the key is a percentage the parent needs a definite
width; see [Layout](#layout).

## Submodel exports

| Export                    | Purpose                                                                                                                                             |
| ------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Model`                   | A `Schema.Struct` plus `type Model = typeof Model.Type`.                                                                                            |
| `Message`                 | `defineMessageUnion({...})` with past-tense names (`Ticked`, `MovedDown`). Only the module constructs them.                                         |
| `OutMessage`              | Facts the parent reacts to (`Selected`). Present only when the parent needs one; `update` then returns `Update.ReturnWithOutMessage`.               |
| `init`                    | A plain `Model`, a function returning a `Model` (`Select.init(options, initial)`), or a function returning `Update.Return` when it starts Commands. |
| `update(model, message)`  | `Message.match` with `modifyFields` from `foldkit/struct`.                                                                                          |
| `view(model, viewInputs)` | Returns a `Node`. `viewInputs` carries parent state (`rows`, `label`) instead of copying it into the Model.                                         |
| `subscriptions`           | Only when the block owns an event source, built with `Subscription.make`.                                                                           |
| `inform*`, `reflect*`     | The only ways a parent changes the child from outside.                                                                                              |

`inform*` runs an internal child Message through `update`, so it can return Commands and an
`OutMessage` (`Select.informKeyPressed(model, key)`). `reflect*` conforms the child to an outside
value silently and returns the child `Model`, with no Commands and no `OutMessage`
(`Select.reflectOptions(model, options)`). Parents never edit a child's fields; they replace the
whole child `Model` that these helpers return.

## Parent composition

The parent keeps the child Model as a field (`build: Spinner.Model`) or as a keyed row
(`rows[i].counter`) and wraps child messages in a `Got*Message` variant, with routing data such as
`id` for keyed rows:

```ts
GotBuildSpinnerMessage: { message: Spinner.Message },
```

- `Update.foldChild({ update, read, write, toParentMessage, foldOutMessage? })` delegates one
  child message. `Update.foldChildAt` does the same for keyed collections.
- `foldOutMessage` turns the child's `OutMessage` into the parent's reaction. See
  [`prompt.ts`](../src/blocks/prompt.ts), where `Selected` stores the chosen value.
- `Subscription.lift(Child.subscriptions)({ read, toParentMessage, when })` moves the child's
  entries into the parent. A closed `when` gate, or `read` returning `None`, stops the stream.
- `lift` keeps the child's entry names and `aggregate` rejects duplicates, so a parent embedding two
  instances renames each entry first:
  `Subscription.aggregate({ buildTicked: build.ticked }, { dbTicked: db.ticked })`.
- View composition is a function call: `Select.view(model.select, { message, rows })`.

[`examples/gallery/main.ts`](../src/examples/gallery/main.ts) shows two lifted spinners where one
stops through its `when` gate. [`examples/counters`](../src/examples/counters/main.ts) shows keyed
rows through `foldChildAt`.

## Root program

`Tui.makeProgram` takes the same shape as Foldkit's `makeElement` and infers the program's type
parameters from it. `Tui.run` starts the program on the terminal:

```ts
const program = Tui.makeProgram({ Model, init, update, view, subscriptions, result });

const total = yield * Tui.run(program, { interruptOnEscape: true });
```

`result` returning `Some` finishes the run with that value. `run` skips `view` and the frame write
when an update returns a model equal to the current one under `Schema.toEquivalence(Model)`.

`view` receives the `Tui.Viewport` as its second argument: the drawable size in cells. Live output
reserves the last column and row for the cursor, so the viewport is one smaller than the terminal
in both directions. One run owns a terminal at a time; a second concurrent `run` on it fails with
`TerminalError` reason `busy`.

A facade such as [`prompt.ts`](../src/blocks/prompt.ts) is a function that takes its inputs as
parameters, builds the program with `makeProgram` and returns `Tui.run(program)`; `Prompt.select`
does this with its message and options. There are no Flags or resources: `run` returns an Effect,
so requirements and inputs flow through it.

## Keys

The root program owns the single key subscription:

```ts
keys: Tui.keyEntry((key) => Message.PressedKey({ key }));
```

Its `update` routes each key to the focused child by folding the child's `informKeyPressed` with the
same `foldChild` boundary it uses for `Got*Message`. Blocks never subscribe to keys themselves.
`RunOptions` decides who sees Escape and Ctrl+C. Escape reaches the program by default;
`interruptOnEscape: true` consumes it and interrupts the run instead (`Prompt.select` sets it).
Ctrl+C and EOF interrupt by default; `handleCtrlC: true` delivers Ctrl+C to the program as a key.

Keys carry modifiers as data (`meta`, and `shift` and `ctrl` on navigation keys), and `isModified(key)`
is true for any modified key. An `inform*` shortcut returns the model unchanged for a modified key,
as `Select.informKeyPressed` does, so `Alt+-` is not read as `-`.

## `reflectOptions`

A parent replaces a select's options `[A, B, C]` with `[A]` while `B` is highlighted. The highlight
moves to `A`, nothing is emitted, and `Selected` arrives only when the user presses Enter. A parent
stores the result by replacing its child field through the helper:

```ts
modifyFields(model, { select: (select) => Select.reflectOptions(select, options) });
```

The story
test `reflectOptions follows the highlighted value, emits nothing, and Selected comes only on Enter`
in [`select.unit.test.ts`](../src/blocks/select.unit.test.ts) covers this case.

## Layout

`View.row` and `View.column` take `View.BoxOptions` that map onto
flexbox, computed by Yoga; [`view/layout.ts`](../src/view/layout.ts) holds the
mapping. Sizes are terminal cells.

| Option                                                              | Values                                                                    | Default           |
| ------------------------------------------------------------------- | ------------------------------------------------------------------------- | ----------------- |
| `gap`                                                               | cells between children, both axes                                         | 0                 |
| `padding`                                                           | `n`, `{ x, y }` or `{ top, right, bottom, left }`                         | 0                 |
| `border`                                                            | `"single"`, `"rounded"` or `{ style, tone }`; one cell on every side      | none              |
| `width`                                                             | cells or `"50%"` of the parent's content width                            | auto              |
| `minWidth`, `maxWidth`, `height`, `minHeight`, `maxHeight`, `basis` | cells                                                                     | auto              |
| `grow`, `shrink`                                                    | flex factors                                                              | 0, 1              |
| `justify`                                                           | `start`, `center`, `end`, `space-between`, `space-around`, `space-evenly` | `start`           |
| `align`, `alignSelf`                                                | `start`, `center`, `end`, `stretch` (`alignSelf` also `auto`)             | `stretch`, `auto` |
| `wrap`                                                              | `true` flows children onto new lines                                      | `false`           |

- `View.spacer()` takes the leftover main-axis space, so `row([title, spacer(), status])` pushes the
  status to the right edge.
- `shrink` defaults to 1, so text wraps or truncates in a narrow pane rather than overflowing. Set
  `shrink: 0` on a child that must keep its width; anything that still overflows is clipped to its
  box.
- A cell `width` is the size unless the parent's main axis shrinks it (default `shrink: 1`); set
  `shrink: 0` to keep it. A panel that should narrow with the terminal is
  `width: "100%", maxWidth: 80`: it is 80 cells on a wide terminal and the pane's width on a narrow
  one, with its border intact. The gallery wraps its KeyValue section this way
  ([`examples/gallery/static.ts`](../src/examples/gallery/static.ts)).
- A percent `width` needs a parent of definite width. Inside a content-sized parent (a column with
  `align` other than `stretch`, or an auto-width row child) Yoga can keep a height measured at
  another width and the painter clips the extra lines. A block that sizes children by percent, like
  KeyValue, fills its parent with `alignSelf: "stretch"` and `grow: 1`; wrap it in a panel that has
  a definite width, such as `width: "100%"` or a cell width.
- Percent applies to `width` only. For "half, but at most" use `width: "50%", maxWidth: 24`.

Limits:

- Two leaves with no cell between them can still join from the left (a trailing ZWJ before an
  emoji, two lone regional indicators forming a flag). Keep at least a gap or a space between
  fields whose glyphs must stay independent.
- Tabs expand per span. A grapheme split across two spans (a styled `1` followed by an unstyled
  keycap mark) can move a later tab stop by a cell, so keep each grapheme inside one span.
- Widths are upper bounds. On a terminal that joins a ZWJ sequence into fewer cells, content placed
  after it on the same row (after a `spacer()`, a right border) shifts left by the difference.

## Theme and legibility

Tones are the contract; the theme maps them to colors. The default theme
([`theme/theme.ts`](../src/theme/theme.ts)) is neutral and uses the terminal's own 16 colors. The
Supabase hex values live in [`supabase/theme.ts`](../src/supabase/theme.ts) and are selected with
`Theme.layer(supabaseTheme)` at the Supabase entry points.

- Tones color glyphs (status symbols, spinner frames, the pointer), borders, and decoration.
- Glyphs are drawn with `View.glyph`, which carries a unicode character and an ASCII alternate.
  Each block owns its glyph table ([`blocks/glyphs.ts`](../src/blocks/glyphs.ts)); the theme holds
  no glyphs.
- Text needed to read the content (values, keys, option labels, messages) uses `default`, with
  emphasis for highlight.
- `muted` is only for hints that can be skipped.
- Color is never the only carrier of meaning: pair it with a glyph or a word.

The rule keeps every block readable on light backgrounds, where the brand green has low contrast.
The Supabase theme is tuned for dark backgrounds.

## Add a gallery entry

1. Render the block in each main state in
   [`examples/gallery/static.ts`](../src/examples/gallery/static.ts) with the `section` helper. The
   static screen is a program that finishes immediately, so it lands in scrollback.
2. If the block needs live behavior, embed it in
   [`examples/gallery/main.ts`](../src/examples/gallery/main.ts) with the composition above.
3. Run it with `bun examples/gallery.ts` from `packages/tui`.
4. Assert the new labels in [`static.integration.test.ts`](../src/examples/gallery/static.integration.test.ts).

## Add a story test

Submodel `update` logic is tested with Foldkit stories: `story(update, given(model), message(...),
model(...))` from `foldkit/story`. Drive the block through `inform*` and `reflect*` as a parent
would, as in [`select.unit.test.ts`](../src/blocks/select.unit.test.ts). Test rendering and
subscriptions through `run` with `withTerminal` from
[`runtime/test-support.ts`](../src/runtime/test-support.ts), advancing time with `TestClock` rather
than sleeping; see [`spinner.integration.test.ts`](../src/blocks/spinner.integration.test.ts).

## Known limits

- Programs cannot read `capabilities.live`, so a spinner is gated on parent state only.
- Prompts have no cancelled frame; Escape interrupts the run.
- The Supabase theme is tuned for dark backgrounds; the default theme follows the terminal's own
  palette.
- A grapheme whose code points arrive in two separate reads decodes as two keys; a split inside one
  UTF-8 character is buffered.
- `Terminal.layerProcess()` is the only supported way to provide a terminal: it drives the
  process's stdin and stdout (or stderr) on Node and Bun. Supplying your own streams is not a
  public API yet.
- Ambiguous-width glyphs count as one cell.
- Select options and one-row decoration truncate at the end on narrow panes, so labels that share a
  long prefix can look identical. Put the distinguishing text first; Select filtering is the
  follow-up for long, similar lists.
