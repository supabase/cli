# `supabase gen bearer-jwt`

## Files Read

| Path                                             | Format             | When                                                                                                                                                                                                     |
| ------------------------------------------------ | ------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `<workdir>/supabase/config.toml` / `config.json` | TOML / JSON        | always when present in the active workdir; used to discover `[auth].enabled` and `[auth].signing_keys_path`                                                                                              |
| `<workdir>/supabase/.env*`, `<workdir>/.env*`    | dotenv             | always, mirroring Go's `flags.LoadConfig`/`Config.Load`'s `loadNestedEnv` step (no `--yes`-style prompt of this command's own reads it, but the load still runs and can itself fail on a malformed file) |
| `<resolved signing_keys_path>`                   | JSON array of JWKs | when `[auth].signing_keys_path` is configured AND `[auth].enabled` is `true` (default) — see Notes for the `auth.enabled = false` quirk                                                                  |
| stdin                                            | plain text / JSON  | interactive/piped prompt for a raw JWK (unconfigured `signing_keys_path`) or a signing-key `kid` (configured, non-TTY)                                                                                   |

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

| Code | Condition                                                                                    |
| ---- | -------------------------------------------------------------------------------------------- |
| `0`  | success — the signed JWT is printed to stdout                                                |
| `1`  | missing required `--role` flag (`required flag(s) "role" not set`, no usage block)           |
| `1`  | malformed `--exp` (not valid RFC3339) or `--valid-for` (not a valid Go duration)             |
| `1`  | malformed `--payload` (`failed to parse payload: ...`)                                       |
| `1`  | `supabase/config.toml` itself is malformed                                                   |
| `1`  | `[auth].signing_keys_path` is configured but the file is missing/unreadable                  |
| `1`  | `[auth].signing_keys_path`'s file is not valid JSON, or not a JSON array of objects          |
| `1`  | the pasted stdin JWK (unconfigured `signing_keys_path`) is not valid JSON / not an object    |
| `1`  | the entered `kid` (configured `signing_keys_path`, non-TTY) matches no key                   |
| `1`  | the resolved JWK has an unsupported key type/curve/algorithm, or a kty-vs-algorithm mismatch |

## Output

### `--output-format text` (Go CLI compatible)

Prints the signed JWT to stdout, followed by exactly one trailing newline — nothing
else ever reaches stdout. Every prompt, echo, and error goes to stderr. Unconditional
on `--output-format` — like the sibling `gen signing-key`, this command's own stdout
IS the machine-readable payload, so `json`/`stream-json` behave identically to `text`.

### `--output-format json`

Same as `text` above (this command has no structured JSON envelope; see Notes).

### `--output-format stream-json`

Same as `text` above.

## Notes

- `--role` is **required** (Postgres role to embed in the token, e.g. `anon`,
  `authenticated`, `service_role`, or any custom role name — no validation against a
  fixed set).
- `--sub` sets the `sub` (subject/user ID) claim. Its Go help text cosmetically shows
  `(default "anonymous")`, but the real default is unset — an omitted `--sub` never
  puts a `sub` claim in the token at all.
- When `--role authenticated` is used with no `--sub`, the token gets `is_anonymous:
true`. Any other role, or `authenticated` with a `--sub`, never sets it.
- `--exp` (RFC3339, e.g. `2030-01-01T00:00:00Z`) sets an explicit expiry; `iat` is then
  computed as `exp - --valid-for`. Without `--exp`, `iat` is "now" and `exp` is `iat +
--valid-for`.
- `--valid-for` (Go duration syntax, e.g. `30m`, `1h`) defaults to 30 minutes.
- `--payload` (default `"{}"`) is arbitrary JSON merged ON TOP of the computed claims —
  any key it sets (including `role`, `exp`, `iat`) overrides the computed value.
- The final claims object is a Go `jwt.MapClaims` (a real map), so its JSON keys are
  serialized in **alphabetical order**, not flag/insertion order — byte-matches Go's
  `encoding/json` map marshalling (including HTML-escaping `<`/`>`/`&`).
- **Signing-key resolution** (Go's `getSigningKey`, fully local, no Docker/network):
  - `[auth].signing_keys_path` **not configured**: prompts `Enter your signing key in
JWK format (or leave blank to use local default): ` on stderr. A blank answer uses
    the built-in default ES256 dev key (kid `b81269f1-21d8-4f2e-b719-c2240a840d90`,
    the same default GoTrue itself signs local dev tokens with). A non-blank answer is
    parsed as a single JWK object.
  - `[auth].signing_keys_path` **configured**, **non-TTY** stdin: prompts `Enter the
kid of your signing key (or leave blank to use the first one): ` on stderr, echoing
    the piped answer back. An exact `kid` match wins (checked before the blank-input
    fallback, so a stored key whose own `kid` is `""` can still match a blank answer);
    otherwise a blank answer uses the first key; otherwise `signing key not found:
<kid>`.
  - `[auth].signing_keys_path` **configured**, **real TTY**: presents an interactive
    picker (`Select a signing key:`) built from each key's `kid`/`alg`/`key_ops`, then
    prints `Selected key ID: <kid>` to stderr. Does not byte-match Go's bubbletea list
    UI (an accepted divergence — see `legacy-project-ref.layer.ts` for the established
    precedent of only matching the observable "Selected ..." line).
  - **`[auth].enabled = false` quirk** (verified against the real binary): Go's
    `Config.Validate` only reads the `signing_keys_path` file when `auth.enabled` is
    `true` — but `getSigningKey` decides which prompt to show purely on whether the
    path STRING is configured, independent of `auth.enabled`. So with auth disabled
    and a path configured, the kid-prompt still runs, but the available keys stay the
    built-in default (the file is never read) — a real kid from the file is reported
    `signing key not found`.
- Byte-matches Go's asymmetric-signing error family exactly: kty/curve failures wrap as
  `failed to convert JWK to private key: ...`; an unsupported algorithm is unwrapped
  (`unsupported algorithm: ...`); a kty-vs-algorithm mismatch (e.g. an EC key signed as
  `RS256`) is caught at sign time and wraps as `failed to sign JWT: key is of invalid
type: ...` — Go has no explicit cross-check between kty and algorithm; this failure
  comes from golang-jwt's own signing method.
- No network or Management API calls, no Docker — fully local, matching Go.
