# 0034. CLI colour system

**Status**: proposed
**Date**: 2026-11-11

## Problem Statement

The CLI has no colour system. [ADR 0001](0001-cli-dx-architecture-pillars.md) gives one line of
guidance (green for success, red for error, yellow for warning, dim for secondary), and
`apps/cli/src/command-internal/colors.ts` exports helpers named after terminal colours: `aqua`,
`bold`, `yellow`, `red`, `green`, `gray`, `dim`, `magenta`, `blue` and `inverse`. Each command picks
from them by taste, so the same colour means different things in different commands: cyan marks a
command to type in one place and is decoration in another.

Terminal themes also redefine the 16 basic colours. A header drawn as black text on green was
unreadable in a light theme whose "black" sat close to its green, and white text was redrawn as
black by a terminal that enforces a minimum contrast.

## Decision

### Roles

Code asks for a role, not a colour. Each role has one meaning:

| Role        | Use for                                                      | Rendering              |
| ----------- | ------------------------------------------------------------ | ---------------------- |
| `brandChip` | The command header chip                                      | Dark text on `#3ECF8E` |
| `command`   | A complete command or flag to type next                      | Cyan                   |
| `emphasis`  | The primary outcome, or a name inside a sentence             | Bold                   |
| `heading`   | Table headers and help headings                              | Bold blue              |
| `muted`     | Frame lines and optional metadata, such as secondary columns | Gray (bright black)    |
| `success`   | A finished step or a healthy state                           | Green                  |
| `warning`   | Something that needs attention but did not stop the command  | Yellow                 |
| `error`     | A failure                                                    | Red                    |

Roles use the terminal's own 16 colours so they follow the user's theme. `brandChip` is the
exception: it is the only background colour, and a background has to keep its text readable in
every theme, so it uses fixed RGB values on truecolour terminals and bright green with black text
elsewhere.

### Rules

- Wording and order carry the meaning; colour only reinforces it. Output must read correctly with
  all styling removed, and turning colour off changes nothing else.
- Values stay plain: IDs, refs, URLs, paths, secrets and data cells are never coloured, so they
  copy cleanly and never read as a status.
- Colour only reaches people. The existing gate turns it off when the stream is not a terminal, in
  CI, and under `NO_COLOR` or `CLICOLOR=0`. Piped stdout stays plain, and agents get JSON.
- `muted` is never used for context, consequences, IDs, choices or recovery steps.
- No new background colours beyond `brandChip`, and remote text such as logs is never recoloured.

### Tables

On a terminal, tables are borderless: a `heading` header row in Title Case, columns separated by spaces, and rows
indented two spaces. Values are never truncated.

Piped tables keep the established `|`-separated format so existing scripts keep working.

### Code

The roles live in `colors.ts` next to the raw helpers. New and changed code imports roles. The raw
helpers stay until existing call sites move to roles, then they are removed.

## Rationale

Named roles keep the look consistent across commands, make review a question of meaning ("is this a
command to type?") rather than taste, and put each colour choice in one place. Theme colours
respect the user's terminal setup; a fixed colour is used only where a background makes contrast
the CLI's responsibility.

## Consequences

### Positive

- One place to change how a role looks.
- Commands with the same kind of output look the same.
- Readable in light and dark themes.

### Negative

- Until migration finishes there are two ways to colour text.
- Terminal and piped tables differ, so a script written against what a person sees on screen
  breaks. Scripts should use `-o json`.

## Alternatives Considered

1. **Keep raw colour helpers**: no shared meaning, so drift continues.
2. **Colour copyable values such as IDs**: makes them easy to spot, but green also means success,
   and coloured values are harder to copy and parse.
3. **Fixed RGB for every role**: matches Supabase brand colours exactly but ignores the user's
   theme, and light green text on a white background is hard to read.
4. **Tab-separated piped tables**: easier to parse, but changes output that scripts depend on.
   Revisit at a major release.
5. **User-configurable themes**: no current need; roles make it possible later.

## Related Decisions

- ADR 0001: CLI DX Architecture: The 7 Pillars
- ADR 0007: Real-time Progress in Command Handlers

## See Also

- [Vercel CLI design guidelines](https://vercel.com/design/cli)
