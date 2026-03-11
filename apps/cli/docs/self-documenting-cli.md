# Self-Documenting CLI

## Problem

CLIs need documentation that stays in sync with command definitions. Manually maintained docs drift. LLMs and AI agents need machine-readable, structured documentation to understand how to use a CLI effectively.

Cobra's guide on [building LLM-friendly CLIs](https://cobra.dev/docs/how-to-guides/clis-for-llms/) highlights that LLMs rely on concrete input/output demonstrations, not abstract descriptions.

## Design

Two modes of documentation, aligned with their audiences:

- `--help` — human-readable text help (Effect CLI built-in)
- `--usage` — machine-readable CLI spec in [usage format](https://usage.jdx.dev) (our addition)

### `--usage` flag

A global flag that outputs the entire CLI structure as a [usage spec](https://usage.jdx.dev/spec/) in KDL format and exits:

```sh
supabase --usage          # full CLI spec
supabase login --usage    # same — always outputs the full spec
```

The usage spec is a standardized format for CLI discovery, analogous to OpenAPI for REST APIs. A single document describes:

- **Metadata** — `bin`, `about`, `version`
- **Flags** — with types, descriptions, aliases, and `global=true` for global flags
- **Arguments** — required (`<name>`) and optional (`[name]`), variadic (`<name...>`)
- **Examples** — concrete usage with descriptions
- **Subcommands** — nested `cmd` blocks with their own flags, args, and examples

### Why usage spec instead of markdown?

The [usage spec](https://usage.jdx.dev) is a standardized, machine-parseable format that enables an ecosystem of tools: shell completions, documentation generation, man pages, and framework scaffolding — all from a single source. Custom markdown required every consumer to parse our specific format.

### Why not a `supabase docs` command?

Documentation is fundamentally an extension of `--help`, not a separate command. Every command already knows how to describe itself. `--usage` is a different rendering of the same information.

### Global flags and Effect CLI

Cobra supports [persistent flags](https://cobra.dev/docs/how-to-guides/working-with-flags/) — flags defined on a parent command that are inherited by all subcommands. Effect CLI supports this via **global flags** — flags that are available on every command and extracted before command parsing.

`--usage` is registered as a global flag using `GlobalFlag.add` at the entry point. It appears in the `GLOBAL FLAGS` section of `--help` output alongside the built-in flags (`--help`, `--version`, `--completions`, `--log-level`).

## Architecture

### Global flag definition (`global-flags.ts`)

The `--usage` flag is a `GlobalFlag.Action` wrapped in a `ServiceMap.Reference`:

```ts
import { Console, ServiceMap } from "effect";
import { Flag, GlobalFlag } from "effect/unstable/cli";
import { formatAsUsageSpec } from "./usage-formatter.ts";

export const UsageFlag = ServiceMap.Reference("@supabase/cli/UsageFlag", {
  defaultValue: (): GlobalFlag.GlobalFlag<boolean> =>
    GlobalFlag.action({
      flag: Flag.boolean("usage").pipe(
        Flag.withDescription("Output CLI spec in usage format (https://usage.jdx.dev) and exit"),
        Flag.withDefault(false),
      ),
      run: (_value, { command, version }) => Console.log(formatAsUsageSpec(command, { version })),
    }),
});
```

The `run` callback receives a `HandlerContext` with the root `command` and `version`. The formatter recursively walks the command tree to produce the full KDL spec.

### Source-defined metadata

Commands define their documentation in source code using Effect CLI's APIs:

```ts
const loginCommand = Command.make("login", flags).pipe(
  Command.withDescription("Long description with context and rationale..."),
  Command.withShortDescription("Short description for listings"),
  Command.withExamples([
    { command: "supabase login", description: "Log in with browser OAuth" },
    { command: "supabase login --token sbp_abc", description: "Log in with a token" },
  ]),
);
```

- `withDescription` — detailed description shown in `--help` and usage spec (`long_about`/`long_help`)
- `withShortDescription` — one-liner used in subcommand listings (`about`/`help`)
- `withExamples` — concrete usage examples rendered in both `--help` and usage spec

### Shared infrastructure

```
src/lib/
├── global-flags.ts            # UsageFlag global flag definition
├── usage-formatter.ts         # Command tree → KDL usage spec
├── usage-formatter.test.ts    # unit tests
├── markdown-formatter.ts      # HelpDoc → markdown string (for README generation)
├── markdown-formatter.test.ts # unit tests
├── docs.ts                    # tree-walking, command navigation
└── docs.test.ts               # unit tests
```

- `formatAsUsageSpec(command, { version })` — recursively walks command tree, outputs KDL usage spec
- `formatHelpDocAsMarkdown(doc)` — converts a `HelpDoc` into markdown sections (README generation)
- `getHelpDoc(command, path)` — extracts structured `HelpDoc` from any command
- `findCommand(root, path)` — navigates the command tree by name segments
- `collectCommands(root, path)` — flattens the tree into a list of `{command, path}`

### README generation

The `scripts/generate-docs.ts` script uses the markdown formatter to update README.md files. Each command's README has `<!-- API:START -->` / `<!-- API:END -->` markers — the script regenerates content between them.

```sh
bun run docs:generate   # update README.md files
bun run docs:check      # validate docs are up-to-date (CI)
```

### Entry point (`supabase.ts`)

Global flags are registered via `GlobalFlag.add` in the Effect pipe chain:

```ts
import { GlobalFlag } from "effect/unstable/cli";
import { UsageFlag } from "./lib/global-flags.ts";

cli.pipe(
  GlobalFlag.add(UsageFlag),
  Effect.provide(formatterLayer),
  Effect.provide(TracingLive.pipe(Layer.provide(BunServices.layer))),
  Effect.provide(BunServices.layer),
  BunRuntime.runMain,
);
```

The global flag registry is a `ServiceMap.Reference<Set<...>>`. `GlobalFlag.add` clones the registry, adds the new reference, and provides it to the downstream effect. The CLI parser extracts global flags from argv before command parsing — action flags (like `--usage`) run their side effect and exit, while setting flags (like `--log-level`) provide a layer to the command handler.

## Effect CLI features used

Four features from Effect V4 that enable source-defined docs:

1. **`Command.withExamples`** ([issue](issues/01-command-examples.md)) — attach concrete examples to commands
2. **`Command.withShortDescription`** ([issue](issues/02-long-description.md)) — separate short (listings) from long (detailed) descriptions
3. **`Command.SubcommandGroup`** ([issue](issues/03-command-groups.md)) — group subcommands in help output
4. **`GlobalFlag`** ([issue](issues/04-persistent-flags.md)) — register global flags visible in `--help` with action/setting semantics
