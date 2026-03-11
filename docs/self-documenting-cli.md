# Self-Documenting CLI

The CLI extracts structured metadata from its command definitions at runtime and serves it in multiple formats. No separate documentation maintenance is needed — the code is the single source of truth.

See [ADR 0003](adr/0003-self-documenting-cli.md) for the original design rationale.

## Global flags

Three global flags power the documentation pipeline:

| Flag | Purpose |
|------|---------|
| `--usage` | Output the full CLI spec in [usage](https://usage.jdx.dev) format (KDL) and exit |
| `--skill` | Auto-detect installed AI agents and write SKILL.md files to each agent's skills directory |
| `--skill-dir <path>` | Write SKILL.md files to a custom directory (useful when no agent is detected or for testing) |

These flags are defined in `apps/cli/src/lib/global-flags.ts` and work from any subcommand position. For example, both `supabase --usage` and `supabase login --usage` emit the same full CLI spec.

### `--usage`

Outputs the entire command tree as a [usage spec](https://usage.jdx.dev/spec/) in KDL format. This is consumed by shell completion engines and documentation generators.

Implementation: `apps/cli/src/lib/usage-formatter.ts`

### `--skill` and `--skill-dir`

Both flags generate [Agent Skills](https://github.com/anthropics/skills) — markdown files that teach AI coding agents how to use the CLI.

`--skill` auto-detects which agents are installed on the machine by checking for their config directories (e.g. `~/.claude`, `~/.cursor`). It writes skill files to each detected agent's conventional skills directory. The agent registry is ported from [Vercel's skills library](https://github.com/vercel-labs/skills/blob/b248cdf08f647faf8b7a00e4d89344d9b83ab0e1/src/agents.ts) and supports 40+ agents.

`--skill-dir <path>` writes to a specific directory instead. Useful for testing or when the target agent isn't auto-detected.

When invoked from a subcommand (e.g. `supabase login --skill`), only that subtree's leaf commands are emitted.

Key files:

| File | Role |
|------|------|
| `apps/cli/src/lib/agent-detect.ts` | Filesystem-based agent detection (40+ agents) |
| `apps/cli/src/lib/skill-writer.ts` | Writes `SKILL.md` files with YAML frontmatter |
| `apps/cli/src/lib/guide-injector.ts` | Injects auto-generated sections into guide templates |
| `apps/cli/src/lib/guide-registry.ts` | Maps command paths to guide entries |

## Guide files

Each command can have an optional `.guide.md` file colocated with its source:

```
apps/cli/src/commands/login/
├── login.command.ts
├── login.handler.ts
├── login.guide.md      ← hand-authored skill template
├── login.integration.test.ts
└── login.e2e.test.ts
```

A guide file is a hand-authored markdown template with HTML comment markers where auto-generated sections get injected:

```md
# Login

Log in to Supabase by providing an access token or using browser-based OAuth.

## When to use

Run once to authenticate before using commands that require auth.

<!-- USAGE:START -->
<!-- USAGE:END -->

<!-- FLAGS:START -->
<!-- FLAGS:END -->

<!-- EXAMPLES:START -->
<!-- EXAMPLES:END -->

## Tips

- Token resolution priority: `--token` flag > `SUPABASE_ACCESS_TOKEN` env > ...
```

Available marker sections: `USAGE`, `FLAGS`, `ARGS`, `EXAMPLES`, `SUBCOMMANDS`. At skill generation time, the injector replaces the content between each marker pair with the auto-generated reference from the command definition.

This lets authors control the narrative structure (intro, "When to use", "Tips") while keeping the reference sections (usage, flags, examples) always in sync with the code.

### Registering a guide

Guides are registered in `apps/cli/src/lib/guide-registry.ts`:

```ts
const guides = new Map<string, GuideEntry>([
  [
    "login",
    {
      template: loginGuide,
      skillName: "supabase-login",
      skillDescription: "Use when you need to authenticate, log in, or ...",
    },
  ],
]);
```

- **Key**: the command path segments joined by space (e.g. `"login"`, `"db push"`)
- **template**: the raw `.guide.md` content, imported with `{ type: "text" }`
- **skillName**: the directory name for the generated SKILL.md
- **skillDescription**: appears in the YAML frontmatter — should include trigger words so agents know when to activate the skill

### Commands without a guide

Commands that don't have a registered guide still get skill files. The fallback uses `formatHelpDocAsMarkdown()` to generate a plain reference page from the command definition, with the skill name derived from the command path (e.g. `supabase-db-push`).

## Docs website

A [Fumadocs](https://fumadocs.dev) site at `apps/docs` serves the command reference as a browsable website. It reuses the same extraction pipeline as the skill generator — command definitions are the single source of truth for both AI skills and human-readable docs.

### How generation works

The script `apps/docs/scripts/generate-docs.ts` runs at build time (`bun run generate`) and:

1. Walks the command tree via `collectCommands()` to find all leaf commands
2. For each command, extracts a `HelpDoc` (description, flags, args, examples)
3. If a `.guide.md` exists for the command, injects the auto-generated sections into the guide template (stripping HTML comment markers for clean MDX output). Otherwise, falls back to `formatHelpDocAsMarkdown()` for a plain reference page
4. Writes each command as `content/docs/commands/<slug>.mdx` with frontmatter
5. Generates `content/docs/commands/index.mdx` — a command reference index with a table linking to every command page
6. Generates `content/docs/commands/meta.json` to control page ordering in the sidebar

### Site structure

```
apps/docs/
├── app/                        ← Next.js app (Fumadocs layout + routing)
│   ├── layout.tsx              ← Root layout (imports fumadocs styles + Supabase theme)
│   ├── supabase.css            ← Supabase color theme overrides
│   └── docs/
│       ├── layout.tsx          ← Docs sidebar layout
│       └── [[...slug]]/page.tsx ← Catch-all page renderer
├── content/docs/               ← MDX content (hand-authored + generated)
│   ├── index.mdx               ← Landing page (hand-authored)
│   ├── getting-started.mdx     ← Quickstart guide (hand-authored)
│   ├── meta.json               ← Top-level page order
│   └── commands/               ← Auto-generated command reference
│       ├── index.mdx           ← Command table (generated)
│       ├── meta.json           ← Command page order (generated)
│       └── login.mdx           ← Individual command page (generated)
├── scripts/
│   └── generate-docs.ts        ← Docs generation script
└── lib/
    └── source.ts               ← Fumadocs content source loader
```

### Running the docs site

```sh
cd apps/docs
bun run generate   # Generate command pages from CLI source
bun run dev        # Start dev server (also runs generate first)
```

## Adding a new command's documentation

1. Write the command definition with descriptions, flags, and examples in the `.command.ts` file — this is the source of truth
2. Optionally create a `<command>.guide.md` with narrative content and injection markers
3. If a guide exists, register it in `guide-registry.ts` with a skill name and description
4. Run `supabase <command> --skill-dir /tmp/test` to verify the generated skill output
5. Run `cd apps/docs && bun run generate` to regenerate the docs website — the new command appears automatically in the command index and sidebar
