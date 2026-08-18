# `supabase completion`

## Files Read

| Path | Format | When |
| ---- | ------ | ---- |
| —    | —      | —    |

## Files Written

These are written by the dynamic `__complete`/`__completeNoDesc` responder
(`legacy/cli/legacy-complete.ts`), not by `supabase completion <shell>` itself —
documented here for the same reason the Environment Variables section below
covers that responder's own env vars: this is the only `SIDE_EFFECTS.md` for
the completion family.

| Path                                            | Format | When                                                                                                                                                                                                                                                                                                                        |
| ----------------------------------------------- | ------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `<SUPABASE_HOME or ~/.supabase>/telemetry.json` | JSON   | Best-effort, on every `__complete`/`__completeNoDesc` request — written by the shared `TelemetryRuntime`/consent bootstrap the `cli_command_executed` capture below runs through (`legacy/telemetry/legacy-telemetry-state.layer.ts`'s file, same path/format), regardless of whether the PostHog delivery itself succeeds. |

## API Routes

| Method | Path | Auth | Request body | Response (used fields) |
| ------ | ---- | ---- | ------------ | ---------------------- |
| —      | —    | —    | —            | —                      |

## Environment Variables

These two are consumed by the dynamic `__complete`/`__completeNoDesc` responder
(`legacy/cli/legacy-complete.ts`, `legacyResolveIncludeDescriptions`), not by
`supabase completion <shell>` itself — documented here because this is the only
`SIDE_EFFECTS.md` for the completion family, and the two hidden commands are only
ever reached via a script this family generates.

| Variable                           | Purpose                                                                                                                                                                                                                                                                                                          | Required? |
| ---------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------- |
| `SUPABASE_COMPLETION_DESCRIPTIONS` | Program-specific override for whether `__complete` includes descriptions (accepted spellings: `1/t/T/TRUE/true/True` = include, `0/f/F/FALSE/false/False` = omit; anything else ignored). Checked before the generic var below. Has no effect on `__completeNoDesc`, which always omits descriptions regardless. | No        |
| `COBRA_COMPLETION_DESCRIPTIONS`    | Generic fallback for the above, checked only when `SUPABASE_COMPLETION_DESCRIPTIONS` is unset or empty.                                                                                                                                                                                                          | No        |

### Telemetry

Every `__complete`/`__completeNoDesc` request also fires the same
`cli_command_executed` PostHog event that fires for every resolved command,
including the hidden `__complete` (CLI-1965 review finding — the old Go binary
passthrough fired this on every tab press, and the native TS interceptor
silently stopped doing so until this was added). `command` is always the
literal `"__complete"`, never `"__completeNoDesc"` (registered as an alias of
the former, and the alias-invariant primary name is what's recorded);
`exit_code` is `0` for a normal response (even with zero matching candidates)
and `1` for an unresolvable request (no completion args at all, see Exit Codes
above); `output_format` is always the fixed literal `"text"`, since
`__complete` never parses `--output`/`-o`. The capture is best-effort and
bounded by a short timeout (`legacy/cli/legacy-complete.ts`'s
`legacyCaptureCompleteTelemetry`) — a missing consent, network hiccup, or DNS
failure never blocks or fails the completion response itself, only adds a
small delay to the process's own exit while it's awaited.

This deliberately does **not** reproduce profile loading, the workdir change,
or a GitHub upgrade-version check for `__complete`: none of those have any
bearing on the analytics contract, and real generated completion shell scripts
always discard this process's stderr, so adding an upgrade message would be a
pure regression, not a parity fix.

## Exit Codes

| Code | Condition                                                                                                                                                                                                                                                                                                                               |
| ---- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `0`  | success — completion script for the chosen shell printed to stdout; also `__complete`/`__completeNoDesc`'s normal case (candidates + `:<directive>` line, even when zero candidates match)                                                                                                                                              |
| `1`  | unknown shell subcommand, or bare `completion` with no shell subcommand — **known divergence, see Notes (CLI-1906)**; also `__complete`/`__completeNoDesc` invoked with no completion args at all (`supabase __complete` alone) — realistically unreachable, since every generated script always appends at least an empty trailing arg |

## Output

`supabase completion <shell>` prints a shell-specific autocompletion script to stdout.
Supports four shells: `bash`, `fish`, `powershell`, `zsh`.

As of CLI-1965, each leaf is generated **natively in TypeScript** — no Go binary is
involved at all. `legacy/commands/completion/legacy-completion-scripts.ts` (`legacyGenerateCompletionScript`)
transcribes cobra v1.10.2's own static script templates byte-for-byte, read directly from
the vendored cobra source rather than reconstructed from memory:

- `spf13/cobra@v1.10.2/bash_completionsV2.go` (`genBashComp`)
- `spf13/cobra@v1.10.2/zsh_completions.go` (`genZshComp`)
- `spf13/cobra@v1.10.2/fish_completions.go` (`genFishComp`)
- `spf13/cobra@v1.10.2/powershell_completions.go` (`genPowerShellComp`)

This is safe to do byte-for-byte because cobra's completion scripts for all four
shells are 100% generic string templates that do **not** bake in the command tree —
the only variables are the program name (always the literal `"supabase"`, hardcoded
as `PROGRAM_NAME`, not read from `os.Argv[0]`), which hidden command the script
calls back into (`__complete` vs `__completeNoDesc`), the six `ShellCompDirective`
bit values, and the two activeHelp constants. Each handler prints the generated
script verbatim via `Output.raw` (no framing, spinner, or JSON envelope). The
scripts are byte-for-byte identical to what the old Go CLI produced, so users who
installed completions previously — cached bytes in their `~/.zshrc`
(`eval "$(supabase completion zsh)"`), brew-managed `_supabase` files in their
`fpath`, or analogous bash/fish/powershell artifacts — see no behavior change.

The generated scripts call back to `supabase __complete <args>` on every tab press to
fetch dynamic completion candidates, or `supabase __completeNoDesc <args>` when the
script was generated with `--no-descriptions` (cobra's alias for the same hidden
command) — see `apps/cli/src/legacy/cli/legacy-complete.ts`, which intercepts both
`__complete` and `__completeNoDesc` before Effect's argv parser and natively
reimplements cobra's dynamic-completion protocol by reflecting over `legacyRoot`
(this repo's own Effect CLI command tree) rather than proxying to the Go binary
(CLI-1965, separate port; its internal candidate/directive algorithm is out of scope
for this doc — see that file's own doc comments — but its externally-visible wire
format, env vars, and exit codes are documented here since it has no `SIDE_EFFECTS.md`
of its own). The wire format written to stdout: one line per candidate (`name` or, when
descriptions are enabled and present, `name\t<first line of description>`), followed by
a final `:<directive>` line (an integer — `0` default, `4` "no file completion", `8`
"filter by file extension", matching a subset of cobra's `ShellCompDirective` bits).

## Notes

- Effect CLI's `--completions` global flag remains exposed at the root for `next/`
  users; it does not satisfy the legacy parity contract and is not what this
  subcommand routes through.
- **Known divergence (CLI-1906):** the old Go CLI exited `0` on both bare
  `completion` (no shell subcommand) AND `completion <unknown-shell>` — an
  unrecognized subcommand name was treated the same as a missing one, printing
  help and returning success. The legacy TS shell currently exits `1` for
  both invocations; this is a real, systemic exit-code bug in the shared CLI
  harness (`shared/cli/run.ts`), not `completion`-specific — it reproduces on
  any bare or unrecognized-subcommand invocation of a group command with
  subcommands (e.g. `branches`, `branches bogus-subcommand`). See CLI-1906 for
  the fix; this doc describes current (buggy) behavior, not the intended
  target.
- Each of `bash`/`zsh`/`fish`/`powershell` declares `--no-descriptions` and
  forwards it into the native generator (selecting the `__completeNoDesc` token
  instead of `__complete`), so the emitted script omits completion descriptions.
- **Accepted `__complete` divergences from real cobra** (see `legacy-complete.ts`'s
  module doc comment for the full, current list and rationale): mutually-exclusive
  flag-group hiding (`MarkFlagsMutuallyExclusive`) is not reproduced — hand-building
  a shadow table at that scale was judged higher-risk than the small, stable tables
  this module does maintain (file extensions, required flags). Deprecated
  commands/flags are not filtered out of candidates either — this TS tree has no
  "deprecated" concept distinct from `hidden` today.
