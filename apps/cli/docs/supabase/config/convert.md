# supabase-config-convert

Converts `supabase/config.toml` to `supabase/config.jsonc` and removes the TOML file. Comments are carried over as `//` comments and the document gets a `$schema` entry, so editors validate it against the hosted config schema.

The conversion reads the file as written: values, including `env(NAME)` references, are copied byte for byte and nothing is resolved from your environment. The converted document is parsed again and compared with the original before anything is written; if the two differ, or the file holds a value JSON cannot represent (a TOML date, `inf` or `nan`), the command refuses and leaves `config.toml` untouched.

Comments keep their place by these rules: a comment directly above a key or table leads it; a comment block directly below a key or table, followed by a blank line or another table, trails it; a comment block with blank lines on both sides leads the next entry; a comment on the same line as a key or table header stays on that line. Comments inside a multi-line array of plain values stay beside their elements. Comments inside nested arrays or inline tables cannot be placed, so this command does not keep them in place: they move to the line above their key and the command lists each one.

Commented-out TOML examples become commented-out JSONC members, so removing the `//` from one member gives valid JSONC. A commented `# key = value` stays in the object it follows as `// "key": value,`. A commented table (`# [auth.hook.custom_access_token]` and the keys under it) is written as a commented object inside the nearest enclosing table that exists, merged with other examples under the same missing parent, and moves with the comment lines directly above it; it sits before the first later-defined entry of that table, or at the end of the table when none follows. Comments that do not parse as a single TOML key or table header stay as plain `//` comments.

`--dry-run` prints the converted document to stdout and writes nothing. If the project has `.vscode/settings.json`, the command also adds the schema domain to `json.schemaDownload.trustedDomains` there, keeping its comments; the file is never created.

Everyone on the project needs Supabase CLI 3.1.0 or later. Older CLIs (before 3.1.0) ignore `config.jsonc` and run with defaults, and some commands (`init`, `functions new`) create a new `config.toml` that newer CLIs then ignore. This is reported as a warning, with an undo command, before anything is written, and never changes the exit code.

If only `supabase/config.json` or `supabase/config.jsonc` exists, the command reports that there is nothing to convert and exits 0. It fails when `config.toml` and a JSON config both exist, because the JSON file takes precedence; delete it first to convert `config.toml` again. The legacy global `-o`/`--output` flag is not supported; use `--output-format json|stream-json` for a machine-readable result.

## Undo

Before committing, restore the TOML file and remove the JSONC one:

```sh
git restore supabase/config.toml && rm supabase/config.jsonc
```

## After converting

- Commit the conversion on its own. The history of the old file stays available with `git log -- supabase/config.toml`.
- Search the repository, CI workflows and Dockerfiles for `config.toml` and update any references.
- Bump pinned Supabase CLI versions (for example `supabase/setup-cli`) to 3.1.0 or later.

```sh
supabase config convert --dry-run
supabase config convert
```
