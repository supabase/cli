# Self-Documenting CLI

The CLI's command definitions are the single source of truth for its reference documentation.
The command tree is introspected at build time to produce the command reference pages served by
the in-repo docs site, so flags, arguments, and examples never drift from the code.

See [ADR 0003](adr/0003-self-documenting-cli.md) for the original design rationale.

This page covers the in-repo [Fumadocs](https://fumadocs.dev) site under `apps/docs`. The
separate pipeline that publishes the command spec to supabase.com is described in
[`apps/cli/docs/README.md`](../apps/cli/docs/README.md).

## How generation works

`apps/cli/scripts/generate-docs.ts` runs as the docs `generate` task before the docs `build` task
when invoked through Turbo (for example, `pnpm run build` from the repository root). The package's
`build` script is a leaf `next build`; `pnpm run generate` remains available for local docs
development. The generator:

1. Walks the command tree from `rootCommand` with `collectCommands()` and keeps the leaf commands.
2. Extracts a `HelpDoc` (description, flags, arguments, examples) for each leaf with `getHelpDoc()`
   and renders it with `formatHelpDocAsMarkdown()`.
3. Writes each command as `content/docs/commands/<path>.mdx` with title and description
   frontmatter.
4. Writes `content/docs/commands/index.mdx`, a table linking to every command page, and
   `content/docs/commands/meta.json`, which controls sidebar order.
5. Copies the built `@supabase/config` JSON schemas into `public/cli/` so the configuration
   reference links resolve. This requires `@supabase/config#build` to have run first, which
   `turbo.json` wires up.

The generated `content/docs/commands/` directory is git-ignored; only the hand-authored pages are
committed.

The extraction helpers live in `apps/cli/src/shared/cli/command-docs.ts` and
`apps/cli/src/shared/cli/markdown-formatter.ts`.

## Site structure

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
│   └── commands/               ← Auto-generated command reference (git-ignored)
├── public/cli/                 ← Generated config schema assets
└── lib/
    └── source.ts               ← Fumadocs content source loader
```

## Running the docs site

```sh
# From the repository root:
pnpm run dev:docs    # Generate command pages, then start the Next.js dev server

# To generate pages without starting the server:
pnpm --filter @supabase/docs run generate
```

## Adding a new command's documentation

1. Write the command definition with descriptions, flags, and examples in the `.command.ts` file.
   That file is the source of truth; there is no separate page to author.
2. Run `pnpm --filter @supabase/docs run generate` to regenerate the site. The new command appears
   in the command index and sidebar automatically.
