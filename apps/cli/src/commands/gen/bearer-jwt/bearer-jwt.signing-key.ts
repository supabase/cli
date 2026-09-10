import { Effect, Option } from "effect";
import {
  assertNoMalformedDuplicateJwkField,
  readSigningKeysFile,
  resolveSigningKeysConfigPaths,
  readOptionalBoolean,
  readOptionalString,
  readOptionalStringArray,
  resolveJwkFieldValue,
} from "../gen.signing-keys-config.ts";
import {
  assertDecodableJwkAlgorithm,
  DEFAULT_SIGNING_KEY,
  type Jwk,
} from "../../../command-internal/go-jwt.ts";
import { goJsonKindName } from "../../../command-internal/go-json.ts";
import { textOutputLayer } from "../../../shared/output/output.layer.ts";
import { Output } from "../../../shared/output/output.service.ts";
import { Stdin } from "../../../shared/runtime/stdin.service.ts";
import { Tty } from "../../../shared/runtime/tty.service.ts";
import {
  bearerJwtErrorMessage,
  GenBearerJwtConfigParseError,
  GenBearerJwtDecodeError,
  GenBearerJwtKeyNotFoundError,
  GenBearerJwtKeyParseError,
  GenBearerJwtKeyPickerAbortedError,
  GenBearerJwtReadError,
} from "./bearer-jwt.errors.ts";

/** Console read-line timeouts. */
const GO_CONSOLE_TTY_TIMEOUT_MILLIS = 10 * 60 * 1000;
const GO_CONSOLE_NON_TTY_TIMEOUT_MILLIS = 100;

/**
 * Writes `label` to stderr with no trailing newline, reads one line bounded
 * by a TTY-aware timeout, and echoes the input back to stderr only on a
 * non-TTY (a real TTY's own line-editing already echoes it).
 */
const consolePromptText = Effect.fnUntraced(function* (label: string) {
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
 * Narrows an untrusted JSON record (a `signing_keys_path` entry, or a pasted
 * stdin JWK) into `Jwk`'s shape, defaulting each missing field the way a Go
 * zero-value struct would.
 *
 * Throws a bare `Error` with the unwrapped `encoding/json` type-mismatch
 * text the moment any field has the wrong JSON type; each call site wraps it
 * with its own prefix. Checks fields in a fixed order rather than the
 * document's own key order, so on a payload with multiple malformed fields
 * the reported field may not always match a real decoder — accepted gap,
 * every field is still rejected either way.
 */
function normalizeStoredJwk(record: Record<string, unknown>): Jwk {
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
  const input = yield* consolePromptText(
    "Enter your signing key in JWK format (or leave blank to use local default): ",
  );
  if (input.length === 0) {
    return DEFAULT_SIGNING_KEY;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(input);
  } catch (cause) {
    return yield* Effect.fail(
      new GenBearerJwtKeyParseError({
        message: `failed to parse JWK: ${bearerJwtErrorMessage(cause)}`,
      }),
    );
  }
  // A JSON `null` answer decodes to a zero-value JWK (same as `{}`), which
  // fails downstream at sign time with "unsupported key type: " — distinct
  // from a truly blank answer (handled above), which falls back to the
  // default key instead.
  if (parsed === null) {
    return normalizeStoredJwk({});
  }
  if (typeof parsed !== "object" || Array.isArray(parsed)) {
    return yield* Effect.fail(
      new GenBearerJwtKeyParseError({
        message: `failed to parse JWK: json: cannot unmarshal ${goJsonKindName(parsed)} into Go value of type config.JWK`,
      }),
    );
  }
  const record = parsed as Record<string, unknown>;
  // Case-insensitive lookup: the `alg` allowlist check runs regardless of
  // the key's casing; see `resolveJwkFieldValue` in `gen.signing-keys-config.ts`.
  const alg = resolveJwkFieldValue(record, "alg");
  try {
    assertDecodableJwkAlgorithm(typeof alg === "string" ? alg : undefined);
  } catch (cause) {
    return yield* Effect.fail(
      new GenBearerJwtKeyParseError({
        message: `failed to parse JWK: ${bearerJwtErrorMessage(cause)}`,
      }),
    );
  }
  // `assertNoMalformedDuplicateJwkField` checks the raw `input` text, not
  // `record`: `JSON.parse` already collapsed any duplicate top-level key to
  // its last occurrence, silently discarding evidence (e.g. `{"kid":1,"kid":"k"}`
  // parses to `record.kid === "k"` with no trace `1` was ever there) that
  // must still be rejected.
  return yield* Effect.try({
    try: () => {
      assertNoMalformedDuplicateJwkField(input);
      return normalizeStoredJwk(record);
    },
    catch: (cause) =>
      new GenBearerJwtKeyParseError({
        message: `failed to parse JWK: ${bearerJwtErrorMessage(cause)}`,
      }),
  });
});

/**
 * Branches B/C (reached when `[auth].signing_keys_path` is configured): a
 * non-TTY prompts for a kid by exact match, falling back to the first key on
 * a blank answer; a real TTY presents an interactive picker instead.
 *
 * Both the picker and its "Selected key ID: ..." line are routed to stderr
 * explicitly rather than the shared `promptSelect`/`info` defaults, since
 * this command's stdout is the signed-token payload even in text mode (see
 * `bearer-jwt.handler.ts`) and clack's own defaults write to stdout.
 *
 * The picker tries the ambient `Output` first (what every test here mocks),
 * falling back to a fresh {@link textOutputLayer} only when that raises
 * `NonInteractiveError` (json/stream-json layers reject prompts outright),
 * so the picker still renders on a real TTY under a non-text ambient layer.
 */
const resolveSigningKeyFromConfigured = Effect.fnUntraced(function* (
  availableKeys: ReadonlyArray<Jwk>,
) {
  const tty = yield* Tty;

  if (!tty.stdinIsTty) {
    const kid = yield* consolePromptText(
      "Enter the kid of your signing key (or leave blank to use the first one): ",
    );
    // The exact kid match runs before the blank-input fallback, so a key
    // whose own `kid` is `""` still matches ahead of "return the first key".
    const found = availableKeys.find((key) => (key.kid ?? "") === kid);
    if (found !== undefined) {
      return found;
    }
    if (kid.length === 0 && availableKeys.length > 0) {
      return availableKeys[0]!;
    }
    return yield* Effect.fail(
      new GenBearerJwtKeyNotFoundError({ message: `signing key not found: ${kid}` }),
    );
  }

  if (availableKeys.length === 0) {
    // A zero-item list must quit immediately: `@clack/prompts`' own
    // `select()` has no "quit on empty options" behavior, and calling it
    // with zero options would crash with a raw `TypeError` instead.
    return yield* Effect.fail(new GenBearerJwtKeyPickerAbortedError({ message: "user aborted" }));
  }

  const output = yield* Output;
  const options = availableKeys.map((key, index) => ({
    value: String(index),
    label: key.kid ?? "",
    hint: `${key.alg ?? ""} (${(key.key_ops ?? []).join(",")})`,
  }));
  // See the doc comment above for why this falls back to `textOutputLayer`.
  const pickSigningKey = (pickerOutput: typeof Output.Service) =>
    Effect.gen(function* () {
      const chosen = yield* pickerOutput.promptSelect("Select a signing key:", options, {
        stream: "stderr",
      });
      const chosenKey = availableKeys[Number(chosen)]!;
      // `output.raw`, not `output.info` (clack's `log.info` defaults to stdout).
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
 * Resolves `[auth].signing_keys_path`'s config, then dispatches to Branch A
 * (unconfigured) or Branches B/C (configured, non-TTY/TTY).
 *
 * When auth is disabled but a path is configured, the kid-prompt branch
 * still runs, but the available keys stay the built-in default since the
 * file is never read — config validation only reads the file when auth is
 * enabled, independent of whether the path string is set. `gen signing-key`
 * shares this same quirk; see `authEnabled` in `gen.signing-keys-config.ts`.
 */
export const resolveBearerJwtSigningKey = Effect.fnUntraced(function* (workdir: string) {
  const paths = yield* resolveSigningKeysConfigPaths(
    workdir,
    (message) => new GenBearerJwtConfigParseError({ message }),
  );

  if (Option.isNone(paths.signingKeysPath)) {
    return yield* resolveSigningKeyFromStdinJwk();
  }

  let availableKeys: ReadonlyArray<Jwk>;
  if (paths.authEnabled) {
    const storedKeys = yield* readSigningKeysFile(
      paths.signingKeysPath.value.actualPath,
      (message) => new GenBearerJwtReadError({ message }),
      (message) => new GenBearerJwtDecodeError({ message }),
    );
    // A malformed field throws via `normalizeStoredJwk` (see its own doc
    // comment), wrapped with the same message `readSigningKeysFile`'s
    // `alg`-allowlist check already uses. A duplicate malformed field is
    // already rejected earlier, inside `readSigningKeysFile` itself.
    availableKeys = yield* Effect.try({
      try: () => storedKeys.map(normalizeStoredJwk),
      catch: (cause) =>
        new GenBearerJwtDecodeError({
          message: `failed to decode signing keys: failed to parse response body: ${bearerJwtErrorMessage(cause)}`,
        }),
    });
  } else {
    availableKeys = [DEFAULT_SIGNING_KEY];
  }

  return yield* resolveSigningKeyFromConfigured(availableKeys);
});
