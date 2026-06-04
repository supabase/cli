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

| Code | Condition                                                          |
| ---- | ------------------------------------------------------------------ |
| `0`  | success — completion script for the chosen shell printed to stdout |
| `1`  | invocation error (missing or unknown shell subcommand)             |

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
fetch dynamic completion candidates — see `apps/cli/src/legacy/commands/__complete/`,
which provides the matching hidden command.

## Notes

- No native TS reimplementation is attempted. Effect's `Completions.generate` API
  emits a static `_arguments`-based zsh function that diverges from Cobra's runtime-
  callback shape; using it here would break the existing user setups described above.
- Effect CLI's `--completions` global flag remains exposed at the root for `next/`
  users; it does not satisfy the legacy parity contract and is not what this
  subcommand routes through.
- The Go CLI exits non-zero when called without a shell subcommand (e.g.
  `supabase completion`). Effect CLI surfaces the same condition through its usual
  "missing subcommand" help-with-exit-1 behavior.
