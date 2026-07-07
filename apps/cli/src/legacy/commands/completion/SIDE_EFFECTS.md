# `supabase completion`

## Files Read

| Path | Format | When |
| ---- | ------ | ---- |
| —    | —      | —    |

## Files Written

| Path | Format | When |
| ---- | ------ | ---- |
| —    | —      | —    |

## API Routes

| Method | Path | Auth | Request body | Response (used fields) |
| ------ | ---- | ---- | ------------ | ---------------------- |
| —      | —    | —    | —            | —                      |

## Environment Variables

| Variable | Purpose | Required? |
| -------- | ------- | --------- |
| —        | —       | —         |

## Exit Codes

| Code | Condition                                                                                                            |
| ---- | -------------------------------------------------------------------------------------------------------------------- |
| `0`  | success — completion script for the chosen shell printed to stdout                                                   |
| `1`  | unknown shell subcommand, or bare `completion` with no shell subcommand — **known divergence, see Notes (CLI-1906)** |

## Output

`supabase completion <shell>` prints a shell-specific autocompletion script to stdout.
The subcommand tree mirrors the Go CLI exactly: `bash`, `fish`, `powershell`, `zsh`.

In the legacy shell every subcommand proxies verbatim to the bundled Go binary via
`LegacyGoProxy`, so the emitted scripts are byte-for-byte identical to what the Go
CLI produced. This matters because users who installed completions with the Go CLI
have those exact bytes cached in their `~/.zshrc` (`eval "$(supabase completion zsh)"`),
brew-managed `_supabase` files in their `fpath`, or analogous bash/fish/powershell
artifacts. Drift would break tab completion for those users.

The generated scripts call back to `supabase __complete <args>` on every tab press to
fetch dynamic completion candidates, or `supabase __completeNoDesc <args>` when the
script was generated with `--no-descriptions` (cobra's alias for the same hidden
command) — see `apps/cli/src/legacy/cli/complete-passthrough.ts`, which intercepts
both `__complete` and `__completeNoDesc` before Effect's argv parser and proxies them
straight to the Go binary.

## Notes

- No native TS reimplementation is attempted. Effect's `Completions.generate` API
  emits a static `_arguments`-based zsh function that diverges from Cobra's runtime-
  callback shape; using it here would break the existing user setups described above.
- Effect CLI's `--completions` global flag remains exposed at the root for `next/`
  users; it does not satisfy the legacy parity contract and is not what this
  subcommand routes through.
- **Known divergence (CLI-1906):** Go's cobra CLI exits `0` on both bare
  `completion` (no shell subcommand) AND `completion <unknown-shell>` — cobra
  treats an unrecognized subcommand name the same as a missing one: a
  non-`Runnable()` command with no `RunE` returns `flag.ErrHelp`, which cobra
  maps to printing help and returning a nil error (verified against the
  compiled Go binary for both cases: `completion` and `completion
bogus-shell` both exit `0`). The legacy TS shell currently exits `1` for
  both invocations; this is a real, systemic exit-code bug in the shared CLI
  harness (`shared/cli/run.ts`), not `completion`-specific — it reproduces on
  any bare or unrecognized-subcommand invocation of a group command with
  subcommands (e.g. `branches`, `branches bogus-subcommand`). See CLI-1906 for
  the fix; this doc describes current (buggy) behavior, not the intended
  target.
- Each of `bash`/`zsh`/`fish`/`powershell` declares `--no-descriptions` (cobra's
  auto-registered flag, `completions.go` in `spf13/cobra`) and forwards it to the
  Go binary, so the emitted script omits completion descriptions exactly as it
  would with the Go CLI.
