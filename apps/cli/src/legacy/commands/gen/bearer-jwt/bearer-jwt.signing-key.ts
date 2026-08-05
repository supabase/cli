import { Effect, Option } from "effect";
import {
  legacyReadSigningKeysFile,
  legacyResolveSigningKeysConfigPaths,
} from "../gen.signing-keys-config.ts";
import {
  legacyAssertDecodableJwkAlgorithm,
  LEGACY_DEFAULT_SIGNING_KEY,
  type LegacyJwk,
} from "../../../shared/legacy-go-jwt.ts";
import { legacyGoJsonKindName } from "../../../shared/legacy-go-json.ts";
import { textOutputLayer } from "../../../../shared/output/output.layer.ts";
import { Output } from "../../../../shared/output/output.service.ts";
import { Stdin } from "../../../../shared/runtime/stdin.service.ts";
import { Tty } from "../../../../shared/runtime/tty.service.ts";
import {
  legacyBearerJwtErrorMessage,
  LegacyGenBearerJwtConfigParseError,
  LegacyGenBearerJwtDecodeError,
  LegacyGenBearerJwtKeyNotFoundError,
  LegacyGenBearerJwtKeyParseError,
  LegacyGenBearerJwtKeyPickerAbortedError,
  LegacyGenBearerJwtReadError,
} from "./bearer-jwt.errors.ts";

/** Go's `Console.ReadLine` timeouts (`apps/cli-go/internal/utils/console.go:35-36`). */
const GO_CONSOLE_TTY_TIMEOUT_MILLIS = 10 * 60 * 1000;
const GO_CONSOLE_NON_TTY_TIMEOUT_MILLIS = 100;

/**
 * Port of Go's `Console.PromptText` (`apps/cli-go/internal/utils/console.go:96-107`):
 * writes `label` to stderr with NO trailing newline, reads one line bounded by a
 * TTY-aware timeout, and — only on a non-TTY — echoes the (trimmed) input back to
 * stderr. On a real TTY the terminal's own line-editing already echoes what the user
 * types, so no explicit echo is written there, matching Go exactly. Used for BOTH of
 * `getSigningKey`'s text prompts (`bearerjwt.go:38`, `:54`) — the branch between them
 * is purely which label/fallback the caller applies to the returned string, not how
 * the read itself behaves.
 */
const legacyConsolePromptText = Effect.fnUntraced(function* (label: string) {
  const output = yield* Output;
  const tty = yield* Tty;
  const stdin = yield* Stdin;
  yield* output.raw(label, "stderr");
  const line = yield* stdin.readLine(
    tty.stdinIsTty ? GO_CONSOLE_TTY_TIMEOUT_MILLIS : GO_CONSOLE_NON_TTY_TIMEOUT_MILLIS,
  );
  const input = Option.getOrElse(line, () => "");
  if (!tty.stdinIsTty) {
    yield* output.raw(`${input}\n`, "stderr");
  }
  return input;
});

/**
 * Go's own `legacyGoJsonKindName` (`legacy-go-json.ts`) is deliberately scoped to
 * scalars only — every one of its existing call sites already excludes null/array/
 * object before reaching it. This file's per-field JWK checks below DO need to name a
 * bare JSON object (`key_ops`'s elements, or a nested value under any field, can be an
 * object — verified against the real binary: `--payload`-style `{}` inside `key_ops`
 * reports `"...into Go struct field JWK.key_ops of type string"` with kind `object`),
 * so this is a local superset rather than a change to that shared, narrower contract.
 */
function jwkFieldKindName(value: unknown): string {
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    return "object";
  }
  return legacyGoJsonKindName(value);
}

/**
 * Go's exact `encoding/json` struct-field type-mismatch text: `"json: cannot unmarshal
 * <kind> into Go struct field JWK.<field> of type <goType>"` — verified against the
 * real binary (CLI-1961) for every field this file reads: `kty`/`kid`/`use`/`alg`/`n`/
 * `e`/`d`/`p`/`q`/`dp`/`dq`/`qi`/`crv`/`x`/`y` (`goType: "string"`), `key_ops` as a
 * whole (`goType: "[]string"`) vs. one of its elements (`goType: "string"`, the same as
 * any other string field), and `ext` (`goType: "bool"`).
 */
function jwkStructFieldTypeMismatch(field: string, value: unknown, goType: string): string {
  return `json: cannot unmarshal ${jwkFieldKindName(value)} into Go struct field JWK.${field} of type ${goType}`;
}

/**
 * A JSON `null` for any `config.JWK` field is a documented Go `encoding/json` no-op —
 * same as a `null` for the whole JWK (see `resolveSigningKeyFromStdinJwk`'s own doc
 * comment) — so `null` must NOT be treated as a type mismatch here, only as "absent".
 */
function isAbsentJwkField(value: unknown): boolean {
  return value === undefined || value === null;
}

/**
 * Reads an optional STRING field, throwing Go's exact struct-field type-mismatch text
 * (see {@link jwkStructFieldTypeMismatch}) when the field is PRESENT with a non-string
 * value — e.g. `{"kid":123}` or `{"ext":"true"}` — rather than silently treating a
 * malformed field as absent the way this function previously did (Codex review
 * finding, CLI-1961): Go's `json.Unmarshal` into `config.JWK` fails outright on any
 * such field, so a mistyped optional field must never let this normalizer still mint a
 * token as if the field had simply been omitted.
 */
function readOptionalString(record: Record<string, unknown>, field: string): string | undefined {
  const value = record[field];
  if (isAbsentJwkField(value)) {
    return undefined;
  }
  if (typeof value !== "string") {
    throw new Error(jwkStructFieldTypeMismatch(field, value, "string"));
  }
  return value;
}

/**
 * Reads the optional `key_ops` STRING ARRAY field, throwing Go's exact struct-field
 * type-mismatch text (see {@link jwkStructFieldTypeMismatch}) when the field is
 * PRESENT but is not an array (`goType: "[]string"`) or contains a non-string element
 * (`goType: "string"`, Go decodes each element individually into the slice's element
 * type) — same "never silently treat malformed as absent" rule as
 * {@link readOptionalString} (Codex review finding, CLI-1961).
 */
function readOptionalStringArray(
  record: Record<string, unknown>,
  field: string,
): ReadonlyArray<string> | undefined {
  const value = record[field];
  if (isAbsentJwkField(value)) {
    return undefined;
  }
  if (!Array.isArray(value)) {
    throw new Error(jwkStructFieldTypeMismatch(field, value, "[]string"));
  }
  for (const entry of value) {
    if (typeof entry !== "string") {
      throw new Error(jwkStructFieldTypeMismatch(field, entry, "string"));
    }
  }
  return value as ReadonlyArray<string>;
}

/**
 * Reads the optional `ext` BOOLEAN field (Go's `*bool`), throwing Go's exact
 * struct-field type-mismatch text (see {@link jwkStructFieldTypeMismatch}) when the
 * field is PRESENT with a non-boolean value — e.g. `{"ext":"true"}` or `{"ext":1}` —
 * same "never silently treat malformed as absent" rule as {@link readOptionalString}
 * (Codex review finding, CLI-1961).
 */
function readOptionalBoolean(record: Record<string, unknown>, field: string): boolean | undefined {
  const value = record[field];
  if (isAbsentJwkField(value)) {
    return undefined;
  }
  if (typeof value !== "boolean") {
    throw new Error(jwkStructFieldTypeMismatch(field, value, "bool"));
  }
  return value;
}

/**
 * Narrows an untrusted JSON record (a `signing_keys_path` file entry, or a pasted
 * stdin JWK) into `LegacyJwk`'s shape — every field Go's own `config.JWK` struct
 * would leave at its zero value (`""`/absent) when missing from the JSON decodes the
 * same way here. Every downstream consumer in this file works with the resulting
 * typed `LegacyJwk`, not the raw untrusted record, so key/kid/alg lookups stay
 * type-checked instead of re-guarding `Record<string, unknown>` at every call site.
 *
 * Throws a bare `Error` (Go's own unwrapped `encoding/json` text) the moment any field
 * above is present with the wrong JSON type — both call sites below (`normalizeStoredJwk`
 * itself is synchronous) catch that throw and apply THEIR OWN Go-matching wrap: Branch
 * A's pasted-JWK path wraps `"failed to parse JWK: %w"`, while the `signing_keys_path`
 * file path wraps `"failed to decode signing keys: failed to parse response body: %w"`
 * — the same two wraps this file's sibling checks (the JSON-decode / `alg` allowlist
 * checks) already use for those exact same two call sites. Go decodes struct fields in
 * the JSON document's own key order and stops at the FIRST mismatch; this function
 * instead always checks in a fixed field order, so on a payload with MULTIPLE
 * simultaneously-malformed fields the reported field may not always match Go's for
 * that specific multi-error case — accepted gap, no fixture in `bearerjwt_test.go`
 * covers ordering across more than one bad field at once, and every field is still
 * correctly rejected either way.
 */
function normalizeStoredJwk(record: Record<string, unknown>): LegacyJwk {
  const keyOps = readOptionalStringArray(record, "key_ops");
  return {
    kty: readOptionalString(record, "kty") ?? "",
    kid: readOptionalString(record, "kid"),
    use: readOptionalString(record, "use"),
    key_ops: keyOps !== undefined ? [...keyOps] : undefined,
    alg: readOptionalString(record, "alg"),
    ext: readOptionalBoolean(record, "ext"),
    n: readOptionalString(record, "n"),
    e: readOptionalString(record, "e"),
    d: readOptionalString(record, "d"),
    p: readOptionalString(record, "p"),
    q: readOptionalString(record, "q"),
    dp: readOptionalString(record, "dp"),
    dq: readOptionalString(record, "dq"),
    qi: readOptionalString(record, "qi"),
    crv: readOptionalString(record, "crv"),
    x: readOptionalString(record, "x"),
    y: readOptionalString(record, "y"),
  };
}

/**
 * Go's `getSigningKey` Branch A (`bearerjwt.go:37-51`, reached when
 * `[auth].signing_keys_path` is NOT configured): prompt for a raw JWK, falling back to
 * the built-in default ES256 dev key on a blank answer.
 */
const resolveSigningKeyFromStdinJwk = Effect.fnUntraced(function* () {
  const input = yield* legacyConsolePromptText(
    "Enter your signing key in JWK format (or leave blank to use local default): ",
  );
  if (input.length === 0) {
    return LEGACY_DEFAULT_SIGNING_KEY;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(input);
  } catch (cause) {
    return yield* Effect.fail(
      new LegacyGenBearerJwtKeyParseError({
        message: `failed to parse JWK: ${legacyBearerJwtErrorMessage(cause)}`,
      }),
    );
  }
  // A JSON `null` answer decodes into a ZERO-VALUE `config.JWK{}` in Go — verified
  // against the real binary (CLI-1961): `json.Unmarshal([]byte("null"), &key)` where
  // `key` is a non-pointer struct is a documented Go no-op (it leaves every field at
  // its zero value: `kty: ""`, `alg: ""`, ...) rather than an error, and rather than
  // the built-in default key. This must reach the SAME zero-value JWK the empty-object
  // shape below does, so it fails downstream at SIGN time with "unsupported key type:
  // " (empty kty) — Go genuinely rejects a `null` answer where a truly BLANK answer
  // (handled above, before `JSON.parse` is ever called) falls back to the default key.
  if (parsed === null) {
    return normalizeStoredJwk({});
  }
  if (typeof parsed !== "object" || Array.isArray(parsed)) {
    return yield* Effect.fail(
      new LegacyGenBearerJwtKeyParseError({
        message: `failed to parse JWK: json: cannot unmarshal ${legacyGoJsonKindName(parsed)} into Go value of type config.JWK`,
      }),
    );
  }
  const record = parsed as Record<string, unknown>;
  const alg = record["alg"];
  try {
    legacyAssertDecodableJwkAlgorithm(typeof alg === "string" ? alg : undefined);
  } catch (cause) {
    return yield* Effect.fail(
      new LegacyGenBearerJwtKeyParseError({
        message: `failed to parse JWK: ${legacyBearerJwtErrorMessage(cause)}`,
      }),
    );
  }
  // `normalizeStoredJwk` throws Go's bare `encoding/json` struct-field type-mismatch
  // text (see its own doc comment) the moment any OTHER field is malformed — e.g.
  // `{"kty":"oct","alg":"ES256","key_ops":["sign",1]}` — wrapped here with the same
  // `"failed to parse JWK: %w"` this Branch A path already uses above (Codex review
  // finding, CLI-1961).
  return yield* Effect.try({
    try: () => normalizeStoredJwk(record),
    catch: (cause) =>
      new LegacyGenBearerJwtKeyParseError({
        message: `failed to parse JWK: ${legacyBearerJwtErrorMessage(cause)}`,
      }),
  });
});

/**
 * Go's `getSigningKey` Branches B/C (`bearerjwt.go:52-83`, reached when
 * `[auth].signing_keys_path` IS configured): non-TTY prompts for a kid by exact
 * string match (falling back to the first key on a blank answer); a real TTY
 * presents an interactive picker instead (`output.promptSelect`, the same
 * `@clack/prompts`-backed pattern `legacy-project-ref.layer.ts` already uses for
 * Go's bubbletea `PromptChoice` — the rendered ANSI never byte-matches Go's TUI
 * either way, so this codebase's established precedent is to match only the
 * observable stderr line Go itself prints after a choice, "Selected key ID: <kid>").
 *
 * Both the picker AND that line are routed to stderr explicitly (`{ stream: "stderr"
 * }` / `output.raw(..., "stderr")` below) rather than the shared `promptSelect`/`info`
 * defaults: Go's own `PromptChoice` comments "Interactive prompts should always be
 * written to stderr" and passes `tea.WithOutput(os.Stderr)`
 * (`internal/utils/prompt.go:127-128`) — but clack's `select()`/`log.info()` default to
 * `process.stdout` (verified directly against the installed `@clack/prompts` source),
 * and this command's own stdout IS the signed-token payload even in text mode (see
 * `bearer-jwt.handler.ts`'s doc comment) — so the unmodified defaults would corrupt a
 * piped/captured token with picker UI and the "Selected key ID: ..." line for any
 * interactive user with a configured `signing_keys_path` (Codex review finding,
 * CLI-1961).
 *
 * The picker tries the AMBIENT `Output` first — this is what every test in this file
 * mocks, and it's what a real `text` run already uses — and only on the AMBIENT
 * `output.promptSelect`/`raw` failing with `NonInteractiveError` (the json/stream-json
 * `Output` layers' unconditional behavior, `output.layer.ts`) does it retry through a
 * FRESH, locally-provided {@link textOutputLayer} instance. This is the same rationale
 * as `legacy/commands/migration/migration.prompt.ts`'s `legacyMigrationConfirm`
 * (CLI-1974): Go's own `PromptChoice` has no concept of an output format at all and
 * always prompts on a real TTY, and this command's stdout is the raw token
 * unconditionally in EVERY format (see `bearer-jwt.handler.ts`'s doc comment) — there
 * is no structured json/stream-json result here for an interactive widget to corrupt,
 * unlike `legacy-project-ref.layer.ts`'s own `promptSelect` (which DOES stay gated
 * behind `output.format`, because ITS caller's json/stream-json mode has a real
 * machine payload an interactive prompt would otherwise interleave with). Verified
 * against the real binary (CLI-1961, Codex review finding): the ambient
 * json/stream-json `Output` layers' `promptSelect` unconditionally raises
 * `NonInteractiveError`, which would abort this command entirely on a real TTY with a
 * configured `signing_keys_path` and more than one stored key — a regression Go never
 * had, since it has no `--output-format` flag to trip over. The try-then-fall-back
 * shape (rather than unconditionally swapping to `textOutputLayer`) is deliberate: it
 * keeps every existing mock-driven test exercising the SAME ambient `Output` path they
 * already do, and only reaches the real, un-mockable `@clack/prompts` renderer in the
 * one combination (`NonInteractiveError` from a genuinely non-text production layer)
 * that requires it.
 */
const resolveSigningKeyFromConfigured = Effect.fnUntraced(function* (
  availableKeys: ReadonlyArray<LegacyJwk>,
) {
  const tty = yield* Tty;

  if (!tty.stdinIsTty) {
    const kid = yield* legacyConsolePromptText(
      "Enter the kid of your signing key (or leave blank to use the first one): ",
    );
    // Go's loop checks every key for an EXACT `KeyID` match BEFORE the blank-input
    // fallback (`bearerjwt.go:59-66`) — so a key whose own `kid` is literally `""`
    // still matches a blank answer here, ahead of "return the first key".
    const found = availableKeys.find((key) => (key.kid ?? "") === kid);
    if (found !== undefined) {
      return found;
    }
    if (kid.length === 0 && availableKeys.length > 0) {
      return availableKeys[0]!;
    }
    return yield* Effect.fail(
      new LegacyGenBearerJwtKeyNotFoundError({ message: `signing key not found: ${kid}` }),
    );
  }

  if (availableKeys.length === 0) {
    // Go's bubbletea `PromptChoice` (`internal/utils/prompt.go:110-140`), given a
    // ZERO-item list, quits immediately without ever letting the user select anything:
    // `errors.New("user aborted")`, unwrapped. Guarded here rather than ever reaching
    // `output.promptSelect` — `@clack/prompts`' own `select()` has no equivalent
    // "immediately quit on an empty option list" behavior to lean on, and calling it
    // with zero options would otherwise resolve to an out-of-range index and crash
    // with a raw `TypeError` when `.kid` is accessed below.
    return yield* Effect.fail(
      new LegacyGenBearerJwtKeyPickerAbortedError({ message: "user aborted" }),
    );
  }

  const output = yield* Output;
  const options = availableKeys.map((key, index) => ({
    value: String(index),
    label: key.kid ?? "",
    hint: `${key.alg ?? ""} (${(key.key_ops ?? []).join(",")})`,
  }));
  // Try the AMBIENT `Output` first (this is what every test in this file mocks, and
  // what a real `text` run already uses) — only on `NonInteractiveError` (the
  // json/stream-json `Output` layers' `promptSelect`/`raw`, `output.layer.ts`) fall
  // back to a REAL, locally-provided `textOutputLayer` instance so the picker still
  // renders on a genuine TTY. `textOutputLayer` only needs `Tty` (already in scope),
  // so this fallback is a purely local override; the token itself is still written
  // through the AMBIENT `Output` later, in `bearer-jwt.handler.ts`, completely
  // unaffected by it. See this function's doc comment above for why Go's own picker
  // needs this at all.
  const pickSigningKey = (pickerOutput: typeof Output.Service) =>
    Effect.gen(function* () {
      const chosen = yield* pickerOutput.promptSelect("Select a signing key:", options, {
        stream: "stderr",
      });
      const chosenKey = availableKeys[Number(chosen)]!;
      // Go: `fmt.Fprintln(os.Stderr, "Selected key ID:", choice.Summary)` (`bearerjwt.go:82`).
      // `output.raw(..., "stderr")`, NOT `output.info` — `info` is clack's `log.info`,
      // which defaults to stdout (see this function's doc comment above).
      yield* pickerOutput.raw(`Selected key ID: ${chosenKey.kid ?? ""}\n`, "stderr");
      return chosenKey;
    });
  return yield* pickSigningKey(output).pipe(
    Effect.catchTag("NonInteractiveError", () =>
      Effect.provide(
        Effect.gen(function* () {
          const realOutput = yield* Output;
          return yield* pickSigningKey(realOutput);
        }),
        textOutputLayer,
      ),
    ),
  );
});

/**
 * Go's `getSigningKey` (`apps/cli-go/internal/gen/bearerjwt/bearerjwt.go:35-84`), fully
 * assembled: resolves `[auth].signing_keys_path`'s config, then dispatches to Branch
 * A (unconfigured) or Branches B/C (configured, non-TTY/TTY).
 *
 * Reproduces the verified `[auth].enabled = false` quirk: Go's `Config.Validate` only
 * reads the `signing_keys_path` FILE inside `if c.Auth.Enabled` (`config.go:1087`), but
 * `getSigningKey` only checks whether the PATH STRING is configured
 * (`len(SigningKeysPath) == 0`) — independent of `auth.enabled`. So when auth is
 * disabled and a path IS configured, the kid-prompt branch still runs, but the actual
 * available keys stay the built-in default (the file is never read) — a real user
 * hitting this combination sees a misleading kid prompt they can never satisfy with
 * their own file's kids. `gen signing-key`'s OWN sibling resolver deliberately does
 * NOT replicate this gate (see `gen.signing-keys-config.ts`'s doc comment) — it reads
 * unconditionally, matching that command's own existing, unrelated Go source.
 */
export const legacyResolveBearerJwtSigningKey = Effect.fnUntraced(function* (workdir: string) {
  const paths = yield* legacyResolveSigningKeysConfigPaths(
    workdir,
    (message) => new LegacyGenBearerJwtConfigParseError({ message }),
  );

  if (Option.isNone(paths.signingKeysPath)) {
    return yield* resolveSigningKeyFromStdinJwk();
  }

  let availableKeys: ReadonlyArray<LegacyJwk>;
  if (paths.authEnabled) {
    const storedKeys = yield* legacyReadSigningKeysFile(
      paths.signingKeysPath.value.actualPath,
      (message) => new LegacyGenBearerJwtReadError({ message }),
      (message) => new LegacyGenBearerJwtDecodeError({ message }),
    );
    // `normalizeStoredJwk` throws Go's bare `encoding/json` struct-field type-mismatch
    // text (see its own doc comment) the moment any stored key entry has a malformed
    // field — e.g. `[{"kty":"oct","alg":"ES256","ext":"true"}]` — wrapped here with the
    // SAME `"failed to decode signing keys: failed to parse response body: %w"` this
    // file's sibling `alg`-allowlist check (inside `legacyReadSigningKeysFile`) already
    // uses for this exact call site (Codex review finding, CLI-1961).
    availableKeys = yield* Effect.try({
      try: () => storedKeys.map(normalizeStoredJwk),
      catch: (cause) =>
        new LegacyGenBearerJwtDecodeError({
          message: `failed to decode signing keys: failed to parse response body: ${legacyBearerJwtErrorMessage(cause)}`,
        }),
    });
  } else {
    availableKeys = [LEGACY_DEFAULT_SIGNING_KEY];
  }

  return yield* resolveSigningKeyFromConfigured(availableKeys);
});
