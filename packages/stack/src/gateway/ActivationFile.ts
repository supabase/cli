import { Crypto, Effect, FileSystem, Path, Redacted, Schema, Scope } from "effect";
import { StackIdSchema } from "../public/StackId.ts";
import { GatewayActivationError } from "../public/Errors.ts";

/** The release is intentionally independent from the Supervisor RPC release. */
export const ACTIVATION_FILE_FORMAT = "supabase-stack-activation-v1" as const;
export const ACTIVATION_PROTOCOL = "gateway-activation-v1" as const;
export const ACTIVATION_FILE_MAX_BYTES = 64 * 1024;

export const ActivationEndpointSchema = Schema.Struct({
  host: Schema.String.pipe(Schema.check(Schema.isNonEmpty())),
  port: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 65_535 })),
});

const TokenSchema = Schema.String.pipe(
  Schema.refine(
    (value): value is string => value.length > 0 && value.length <= 256 && !/\s/.test(value),
    {
      identifier: "ActivationToken",
      message: "Expected a bounded activation token",
    },
  ),
);
const RedactedTokenSchema = Schema.RedactedFromValue(TokenSchema);

const SessionSchema = Schema.String.pipe(
  Schema.refine((value): value is string => /^[A-Za-z0-9_-]{1,128}$/.test(value), {
    identifier: "OwnerSessionId",
    message: "Expected a bounded owner session identifier",
  }),
);

export const ActivationFileSchema = Schema.Struct({
  format: Schema.Literal(ACTIVATION_FILE_FORMAT),
  endpoint: ActivationEndpointSchema,
  capability: RedactedTokenSchema,
  stackId: StackIdSchema,
  desiredGeneration: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  gatewayInstanceId: TokenSchema,
  ownerSessionId: SessionSchema,
});

export type ActivationEndpoint = Schema.Schema.Type<typeof ActivationEndpointSchema>;
export type ActivationFile = Schema.Schema.Type<typeof ActivationFileSchema>;

const sameActivationFile = (left: ActivationFile, right: ActivationFile): boolean =>
  left.format === right.format &&
  Redacted.value(left.capability) === Redacted.value(right.capability) &&
  left.stackId === right.stackId &&
  left.desiredGeneration === right.desiredGeneration &&
  left.gatewayInstanceId === right.gatewayInstanceId &&
  left.ownerSessionId === right.ownerSessionId &&
  left.endpoint.host === right.endpoint.host &&
  left.endpoint.port === right.endpoint.port;

const fileError = (message: string, cause?: unknown): GatewayActivationError =>
  new GatewayActivationError({
    message,
    ...(cause === undefined ? {} : { cause }),
  });

const encode = (value: ActivationFile): Effect.Effect<string, GatewayActivationError> =>
  Schema.encodeEffect(Schema.fromJsonString(ActivationFileSchema))(value).pipe(
    Effect.mapError((cause) => fileError("Unable to encode gateway activation file", cause)),
  );

/** Read and exact-schema decode an activation file. */
export const readActivationFile = (
  path: string,
): Effect.Effect<ActivationFile, GatewayActivationError, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const info = yield* fs
      .stat(path)
      .pipe(Effect.mapError((error) => fileError("Unable to read gateway activation file", error)));
    if (info.size > BigInt(ACTIVATION_FILE_MAX_BYTES))
      return yield* fileError("Gateway activation file exceeds the size limit");
    const text = yield* fs
      .readFileString(path)
      .pipe(Effect.mapError((error) => fileError("Unable to read gateway activation file", error)));
    if (new TextEncoder().encode(text).byteLength > ACTIVATION_FILE_MAX_BYTES)
      return yield* fileError("Gateway activation file exceeds the size limit");
    const decoded = yield* Schema.decodeEffect(Schema.fromJsonString(ActivationFileSchema))(text, {
      onExcessProperty: "error",
    }).pipe(Effect.mapError(() => fileError("Gateway activation file has an invalid format")));
    return decoded;
  });

/**
 * Atomically publish an owner-only activation file. The temporary file is
 * created with O_EXCL, chmod'd to 0600, and renamed into place. A scope
 * finalizer removes the published file and any temporary path.
 */
export const writeActivationFile = (
  path: string,
  value: ActivationFile,
): Effect.Effect<
  ActivationFile,
  GatewayActivationError,
  FileSystem.FileSystem | Path.Path | Crypto.Crypto | Scope.Scope
> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const pathService = yield* Path.Path;
    const crypto = yield* Crypto.Crypto;
    const encoded = yield* encode(value);
    const temporary = `${path}.${yield* crypto.randomUUIDv4}.tmp`;
    yield* Effect.addFinalizer(() =>
      Effect.ignore(
        readActivationFile(path).pipe(
          Effect.flatMap((current) =>
            sameActivationFile(current, value) ? fs.remove(path, { force: true }) : Effect.void,
          ),
          // Temporary cleanup must run even when the published path was
          // rotated or is no longer readable.
          Effect.ensuring(Effect.ignore(fs.remove(temporary, { force: true }))),
        ),
      ),
    );
    // Resolve the path through Path so callers cannot accidentally provide a
    // platform-incompatible separator to the temporary-name operation.
    const temporaryPath = pathService.join(
      pathService.dirname(path),
      pathService.basename(temporary),
    );
    yield* Effect.gen(function* () {
      yield* fs
        .writeFileString(temporaryPath, encoded, { flag: "wx", mode: 0o600 })
        .pipe(
          Effect.mapError((error) => fileError("Unable to publish gateway activation file", error)),
        );
      yield* fs
        .chmod(temporaryPath, 0o600)
        .pipe(
          Effect.mapError((error) => fileError("Unable to secure gateway activation file", error)),
        );
      yield* fs
        .rename(temporaryPath, path)
        .pipe(
          Effect.mapError((error) => fileError("Unable to publish gateway activation file", error)),
        );
      yield* fs
        .chmod(path, 0o600)
        .pipe(
          Effect.mapError((error) => fileError("Unable to secure gateway activation file", error)),
        );
    }).pipe(Effect.ensuring(Effect.ignore(fs.remove(temporaryPath, { force: true }))));
    return value;
  }).pipe(
    Effect.mapError((error) =>
      error instanceof GatewayActivationError
        ? error
        : fileError("Unable to publish gateway activation file", error),
    ),
  );

/** Generate a high-entropy capability that remains redacted outside the wire leaf. */
export const generateActivationCapability: Effect.Effect<
  Redacted.Redacted<string>,
  GatewayActivationError,
  Crypto.Crypto
> = Effect.gen(function* () {
  const crypto = yield* Crypto.Crypto;
  const bytes = yield* crypto.randomBytes(32);
  const token = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
  return Redacted.make(token);
}).pipe(Effect.mapError((cause) => fileError("Unable to generate activation capability", cause)));
