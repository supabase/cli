import { Effect, Option, Schema } from "effect";
import {
  assertNoMalformedDuplicateJwkField,
  legacyReadSigningKeysFile,
  legacyResolveSigningKeysConfigPaths,
  readOptionalBoolean,
  readOptionalString,
  readOptionalStringArray,
  resolveJwkFieldValue,
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

/** Established console read-line timeouts. */
const GO_CONSOLE_TTY_TIMEOUT_MILLIS = 10 * 60 * 1000;
const GO_CONSOLE_NON_TTY_TIMEOUT_MILLIS = 100;
const decodeJsonString = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Unknown));

/**
 * Writes `label` to stderr with NO trailing newline, reads one line bounded
 * by a TTY-aware timeout, and — only on a non-TTY — echoes the (trimmed)
 * input back to stderr. On a real TTY the terminal's own line-editing
 * already echoes what the user types, so no explicit echo is written
 * there. Used for BOTH of `getSigningKey`'s text prompts — the branch
 * between them is purely which label/fallback the caller applies to the
 * returned string, not how the read itself behaves.
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
 * Narrows an untrusted JSON record (a `signing_keys_path` file entry, or a pasted
 * stdin JWK) into `LegacyJwk`'s shape — every field `config.JWK` would
 * leave at its zero value (`""`/absent) when missing from the JSON decodes
 * the same way here. Every downstream consumer in this file works with the
 * resulting typed `LegacyJwk`, not the raw untrusted record, so
 * key/kid/alg lookups stay type-checked instead of re-guarding
 * `Record<string, unknown>` at every call site.
 *
 * Throws a bare `Error` (the established unwrapped `encoding/json` text)
 * the moment any field above is present with the wrong JSON type — both
 * call sites below (`normalizeStoredJwk` itself is synchronous) catch that
 * throw and apply THEIR OWN established wrap: Branch A's pasted-JWK path
 * wraps `"failed to parse JWK: %w"`, while the `signing_keys_path` file
 * path wraps `"failed to decode signing keys: failed to parse response
 * body: %w"` — the same two wraps this file's sibling checks (the
 * JSON-decode / `alg` allowlist checks) already use for those exact same
 * two call sites. Decoding processes struct fields in the JSON document's
 * own key order and stops at the FIRST mismatch; this function instead
 * always checks in a fixed field order, so on a payload with MULTIPLE
 * simultaneously-malformed fields the reported field may not always match
 * the established decoder for that specific multi-error case — accepted
 * gap, no fixture covers ordering across more than one bad field at once,
 * and every field is still correctly rejected either way.
 * `readOptionalString`/`readOptionalStringArray`/`readOptionalBoolean` are
 * hoisted to `gen.signing-keys-config.ts` (the `gen` family root) rather
 * than defined locally: `assertNoMalformedDuplicateJwkField` there needs
 * the exact same per-field checks to catch a DUPLICATED field whose
 * earlier occurrence `JSON.parse` alone would have silently discarded —
 * see both call sites below, and that function's own doc comment for the
 * mechanics.
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
 * Branch A (reached when `[auth].signing_keys_path` is NOT configured):
 * prompt for a raw JWK, falling back to the built-in default ES256 dev key
 * on a blank answer.
 */
const resolveSigningKeyFromStdinJwk = Effect.fnUntraced(function* () {
  const input = yield* legacyConsolePromptText(
    "Enter your signing key in JWK format (or leave blank to use local default): ",
  );
  if (input.length === 0) {
    return LEGACY_DEFAULT_SIGNING_KEY;
  }
  const parsed = yield* Effect.try({
    try: () => decodeJsonString(input),
    catch: (cause) =>
      new LegacyGenBearerJwtKeyParseError({
        message: `failed to parse JWK: ${legacyBearerJwtErrorMessage(cause)}`,
      }),
  });
  // A JSON `null` answer decodes into a ZERO-VALUE `config.JWK{}`:
  // `json.Unmarshal([]byte("null"), &key)` where `key` is a non-pointer
  // struct is a documented no-op (it leaves every field at its zero value:
  // `kty: ""`, `alg: ""`, ...) rather than an error, and rather than the
  // built-in default key. This must reach the SAME zero-value JWK the
  // empty-object shape below does, so it fails downstream at SIGN time
  // with "unsupported key type: " (empty kty) — a `null` answer is
  // genuinely rejected where a truly BLANK answer (handled above, before
  // `JSON.parse` is ever called) falls back to the default key.
  if (parsed === null) {
    return normalizeStoredJwk({});
  }
  if (typeof parsed !== "object" || Array.isArray(parsed)) {
    return yield* new LegacyGenBearerJwtKeyParseError({
      message: `failed to parse JWK: json: cannot unmarshal ${legacyGoJsonKindName(parsed)} into Go value of type config.JWK`,
    });
  }
  const record: Record<string, unknown> = Object.fromEntries(Object.entries(parsed));
  // Case-insensitive lookup (`resolveJwkFieldValue`) — the `alg` allowlist
  // check (`config.Algorithm.UnmarshalText`) runs at JSON-decode time
  // regardless of the key's casing; see that function's doc comment in
  // `gen.signing-keys-config.ts`.
  const alg = resolveJwkFieldValue(record, "alg");
  yield* Effect.try({
    try: () => legacyAssertDecodableJwkAlgorithm(typeof alg === "string" ? alg : undefined),
    catch: (cause) =>
      new LegacyGenBearerJwtKeyParseError({
        message: `failed to parse JWK: ${legacyBearerJwtErrorMessage(cause)}`,
      }),
  });
  // `normalizeStoredJwk` throws the established bare `encoding/json`
  // struct-field type-mismatch text (see its own doc comment) the moment
  // any OTHER field is malformed — e.g.
  // `{"kty":"oct","alg":"ES256","key_ops":["sign",1]}` — wrapped here with
  // the same `"failed to parse JWK: %w"` this Branch A path already uses
  // above.
  //
  // `assertNoMalformedDuplicateJwkField` runs FIRST, against `input` — the untouched
  // pasted text — rather than `record`: by the time `parsed`/`record` exist, `JSON.parse`
  // has ALREADY collapsed any duplicate top-level key down to its last occurrence (plain
  // JS object-literal semantics), silently discarding evidence of an earlier occurrence
  // that must still be rejected — e.g. a pasted `{"kid":1,"kid":"k"}` parses to
  // `record.kid === "k"` with no trace `1` was ever there, yet decoding into
  // `config.JWK` still errors on the `1` and never reaches `normalizeStoredJwk`'s
  // equivalent of the merged, valid `"k"` (see that function's own doc
  // comment for the full mechanics, including the `alg` field's distinct
  // allowlist-driven behavior).
  return yield* Effect.try({
    try: () => {
      assertNoMalformedDuplicateJwkField(input);
      return normalizeStoredJwk(record);
    },
    catch: (cause) =>
      new LegacyGenBearerJwtKeyParseError({
        message: `failed to parse JWK: ${legacyBearerJwtErrorMessage(cause)}`,
      }),
  });
});

/**
 * Branches B/C (reached when `[auth].signing_keys_path` IS configured):
 * non-TTY prompts for a kid by exact string match (falling back to the
 * first key on a blank answer); a real TTY presents an interactive picker
 * instead (`output.promptSelect`, the same `@clack/prompts`-backed pattern
 * `legacy-project-ref.layer.ts` already uses for the established
 * bubbletea-style `PromptChoice` — the rendered ANSI never byte-matches a
 * TUI either way, so this codebase's established precedent is to match
 * only the observable stderr line printed after a choice, "Selected key
 * ID: <kid>").
 *
 * Both the picker AND that line are routed to stderr explicitly (`{ stream: "stderr"
 * }` / `output.raw(..., "stderr")` below) rather than the shared `promptSelect`/`info`
 * defaults: interactive prompts should always be written to stderr — but
 * clack's `select()`/`log.info()` default to `process.stdout`, and this
 * command's own stdout IS the signed-token payload even in text mode (see
 * `bearer-jwt.handler.ts`'s doc comment) — so the unmodified defaults would
 * corrupt a piped/captured token with picker UI and the "Selected key ID:
 * ..." line for any interactive user with a configured `signing_keys_path`.
 *
 * The picker tries the AMBIENT `Output` first — this is what every test in this file
 * mocks, and it's what a real `text` run already uses — and only on the AMBIENT
 * `output.promptSelect`/`raw` failing with `NonInteractiveError` (the json/stream-json
 * `Output` layers' unconditional behavior, `output.layer.ts`) does it retry through a
 * FRESH, locally-provided {@link textOutputLayer} instance. This is the same rationale
 * as `legacy/commands/migration/migration.prompt.ts`'s `legacyMigrationConfirm`:
 * the established `PromptChoice` has no concept of an output format at all and
 * always prompts on a real TTY, and this command's stdout is the raw token
 * unconditionally in EVERY format (see `bearer-jwt.handler.ts`'s doc comment) — there
 * is no structured json/stream-json result here for an interactive widget to corrupt,
 * unlike `legacy-project-ref.layer.ts`'s own `promptSelect` (which DOES stay gated
 * behind `output.format`, because ITS caller's json/stream-json mode has a real
 * machine payload an interactive prompt would otherwise interleave with). The ambient
 * json/stream-json `Output` layers' `promptSelect` unconditionally raises
 * `NonInteractiveError`, which would abort this command entirely on a real TTY with a
 * configured `signing_keys_path` and more than one stored key. The try-then-fall-back
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
    // The exact `KeyID` match check runs BEFORE the blank-input fallback —
    // so a key whose own `kid` is literally `""` still matches a blank
    // answer here, ahead of "return the first key".
    const found = availableKeys.find((key) => (key.kid ?? "") === kid);
    if (found !== undefined) {
      return found;
    }
    if (kid.length === 0 && availableKeys.length > 0) {
      return availableKeys[0]!;
    }
    return yield* new LegacyGenBearerJwtKeyNotFoundError({
      message: `signing key not found: ${kid}`,
    });
  }

  if (availableKeys.length === 0) {
    // A ZERO-item list must quit immediately without ever letting the user
    // select anything: `errors.New("user aborted")`, unwrapped. Guarded
    // here rather than ever reaching `output.promptSelect` —
    // `@clack/prompts`' own `select()` has no equivalent "immediately quit
    // on an empty option list" behavior to lean on, and calling it with
    // zero options would otherwise resolve to an out-of-range index and
    // crash with a raw `TypeError` when `.kid` is accessed below.
    return yield* new LegacyGenBearerJwtKeyPickerAbortedError({ message: "user aborted" });
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
  // renders on a genuine TTY. `textOutputLayer` needs only `Tty` and `Stdio`, both
  // ambient from the CLI root, so this fallback is a local override; the token is written
  // through the AMBIENT `Output` later, in `bearer-jwt.handler.ts`, completely
  // unaffected by it. See this function's doc comment above for why this
  // picker needs this at all.
  const pickSigningKey = (pickerOutput: typeof Output.Service) =>
    Effect.gen(function* () {
      const chosen = yield* pickerOutput.promptSelect("Select a signing key:", options, {
        stream: "stderr",
      });
      const chosenKey = availableKeys[Number(chosen)]!;
      // `output.raw(..., "stderr")`, NOT `output.info` — `info` is clack's
      // `log.info`, which defaults to stdout (see this function's doc
      // comment above).
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
 * Fully assembled: resolves `[auth].signing_keys_path`'s config, then
 * dispatches to Branch A (unconfigured) or Branches B/C (configured,
 * non-TTY/TTY).
 *
 * Reproduces the established `[auth].enabled = false` quirk: config
 * validation only reads the `signing_keys_path` FILE when auth is enabled,
 * but `getSigningKey` only checks whether the PATH STRING is configured —
 * independent of `auth.enabled`. So when auth is disabled and a path IS
 * configured, the kid-prompt branch still runs, but the actual available
 * keys stay the built-in default (the file is never read) — a real user
 * hitting this combination sees a misleading kid prompt they can never
 * satisfy with their own file's kids. `gen signing-key`'s OWN sibling
 * resolver ({@link legacyGenSigningKey}'s `loadSigningKeysConfig`) needs and
 * replicates this exact same gate — it goes through the identical config
 * load and validation pipeline as this command, so it is subject to the
 * same auth-disabled quirk (see `gen.signing-keys-config.ts`'s
 * `authEnabled` doc comment).
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
    // `normalizeStoredJwk` throws the established bare `encoding/json`
    // struct-field type-mismatch text (see its own doc comment) the moment
    // any stored key entry has a malformed field — e.g.
    // `[{"kty":"oct","alg":"ES256","ext":"true"}]` — wrapped here with the
    // SAME `"failed to decode signing keys: failed to parse response body: %w"` this
    // file's sibling `alg`-allowlist check (inside `legacyReadSigningKeysFile`) already
    // uses for this exact call site. A DUPLICATE
    // malformed field (e.g. `[{"kid":1,"kid":"k1",...}]`) is already rejected earlier,
    // by `legacyReadSigningKeysFile` itself calling `assertNoMalformedDuplicateJwkField`
    // against each element's own raw source text — `storedKeys` here is guaranteed
    // free of that gap by the time this runs.
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
