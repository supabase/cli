# `supabase experiments disable <FEATURE>…`

## Files Read

| Path                             | Format | When                                                            |
| -------------------------------- | ------ | --------------------------------------------------------------- |
| `<workdir>/supabase/config.toml` | TOML   | always, unless the project is configured by `config.json`       |
| `<workdir>/supabase/config.json` | JSON   | always, when it exists (it takes precedence over `config.toml`) |

The project is located from `CommandSettings.workdir`, climbing ancestor
directories unless `--workdir`/`SUPABASE_WORKDIR` named one explicitly.

## Files Written

| Path                                    | Format       | When                                                    |
| --------------------------------------- | ------------ | ------------------------------------------------------- |
| `<workdir>/supabase/config.{toml,json}` | same as read | only when at least one named experiment is currently on |

The write is a surgical, format-preserving edit through `applyConfigEdits`: it
sets `experimental.<feature> = false` inside the existing `[experimental]`
table, or creates that table when the document has none. Comments, key order,
spacing, and quoting elsewhere in the file survive byte-for-byte. The file is
replaced atomically (write to a sibling temp file, then rename), preserving its
mode.

An experiment the document never mentions already resolves to off, so disabling
it writes nothing rather than recording a redundant `false`.

## API Routes

None called directly. `cli_command_executed` may be sent to PostHog.

## Environment Variables

| Variable                        | Purpose                                                   | Required?                         |
| ------------------------------- | --------------------------------------------------------- | --------------------------------- |
| `SUPABASE_WORKDIR`              | locate the project when `--workdir` is absent             | no (defaults to an ancestor walk) |
| `SUPABASE_EXPERIMENTAL_COMPUTE` | read only to warn that it overrides what was just written | no                                |
| `SUPABASE_EXPERIMENTAL_STACK`   | read only to warn that it overrides what was just written | no                                |

The `SUPABASE_EXPERIMENTAL_*` variables are never written and never consulted
to decide what to write — the command always records the project setting. They
are read solely so the output can say when the current shell will ignore it.

## Exit Codes

| Code | Condition                                                                                                                                                                                 |
| ---- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `0`  | success, including a run where every named experiment was already disabled                                                                                                                |
| `1`  | no project config found; config unreadable or unwritable; unknown feature name; `-o`/`--output` passed; the document's layout refused the edit (e.g. a duplicate `[experimental]` header) |

## Output

Text mode writes one line per named experiment:

```text
Disabled compute in /path/to/supabase/config.toml.
stack is already disabled in /path/to/supabase/config.toml.
```

followed by one line per experiment whose environment override shadows the file:

```text
Note: SUPABASE_EXPERIMENTAL_COMPUTE=1 takes precedence over /path/to/supabase/config.toml for this shell.
```

`--output-format json`/`stream-json` emit a result payload instead:
`{config_path, enabled, experiments: [{name, previous, changed, env_override}]}`.

`-o`/`--output` is rejected outright; this command has no Go-compatible output
contract, so `--output-format` is the only machine-format flag.

## Notes

- The feature name is a closed enum (`compute`, `stack`), validated by the
  argument parser, so an unknown name fails before any file is read.
- Repeating a name (`disable compute compute`) reports it once.
