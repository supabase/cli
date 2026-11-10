# supabase-config-convert

Converts `supabase/config.toml` to `supabase/config.jsonc` and moves the TOML file to `supabase/.temp/config.toml.bak`. Comments are carried over as `//` comments and the document gets a `$schema` entry, so editors validate it against the hosted config schema.

The conversion reads the file as written: values keep their meaning, `env(NAME)` references are copied as text, and nothing is resolved from your environment. Numbers are written in JSON form, so `0x1F` becomes `31` and `1_000` becomes `1000`. The converted document is parsed again and compared with the original before anything is written; if the two differ, the file is not valid UTF-8, or it holds a value JSON cannot represent (a TOML date, `inf` or `nan`), the command refuses and leaves `config.toml` untouched.

Comments keep their place by these rules: a comment directly above a key or table leads it; a comment block directly below a key or table, followed by a blank line or another table, trails it; a comment block with blank lines on both sides leads the next entry, or the commented-out example that follows it; a comment on the same line as a key or table header stays on that line. Comments inside a multi-line array of plain values stay beside their elements. Comments inside nested arrays or inline tables cannot be placed, so this command does not keep them in place: they move to the line above their key and the command lists each one.

Commented-out TOML examples become commented-out JSONC members, so removing the `//` from one member gives valid JSONC. A commented `# key = value` stays in the object it follows as `// "key": value,`. A commented table (`# [auth.hook.custom_access_token]` and the keys under it) is written as a commented object inside the nearest enclosing table that exists, merged with other examples under the same missing parent, and moves with the comment lines directly above it; it sits before the first later-defined entry of that table, or at the end of the table when none follows. Comments that do not parse as a single TOML key or table header stay as plain `//` comments.

Two kinds of commented example are copied as plain comments or need care when uncommented. Examples inside an array of tables (`[[name]]`, commented or not) stay as plain `//` comments. When a table lists alternative values for the same key (`# key = "a"` then `# key = "b"`), both become commented members, so uncomment only one of them.

`--dry-run` prints the converted document to stdout and writes nothing. If the project has `.vscode/settings.json`, the command also adds the schema domain to `json.schemaDownload.trustedDomains` there, keeping its comments; the file is never created.

Everyone on the project needs Supabase CLI 3.1.0 or later: older CLIs ignore `config.jsonc` and run with defaults. The command ends with a summary of the files it created, moved and updated, any relocated comments, this compatibility note and the undo command; with `--dry-run` the same summary, as a preview, goes to stderr.

If only `supabase/config.json` or `supabase/config.jsonc` exists, the command reports that there is nothing to convert and exits 0. It fails when `config.toml` and a JSON config both exist, because the JSON file takes precedence; delete it first to convert `config.toml` again. The legacy global `-o`/`--output` flag is not supported; use `--output-format json|stream-json` for a machine-readable result.

## Undo

Move the backup back and remove the JSONC file:

```sh
mv supabase/.temp/config.toml.bak supabase/config.toml && rm supabase/config.jsonc
```

If a backup from an earlier conversion already exists, the command uses the next free name (`config.toml.2.bak`, and so on). The printed undo command names that backup, with paths relative to the directory you ran the command from.

## After converting

- Commit the conversion on its own. The history of the old file stays available with `git log -- supabase/config.toml`.
- Search the repository, CI workflows and Dockerfiles for `config.toml` and update any references.
- Bump pinned Supabase CLI versions (for example `supabase/setup-cli`) to 3.1.0 or later.

```sh
supabase config convert --dry-run
supabase config convert
```
