import {
  Clock,
  Duration,
  Effect,
  FileSystem,
  Option,
  Path,
  PlatformError,
  Predicate,
  Schedule,
  Schema,
} from "effect";
import { SecureRandom } from "effect/crypto";
import { CliSettings } from "../config/cli-settings.service.ts";
import {
  type ConsentState,
  PersistedNumberSchema,
  TelemetryConfigSchema,
  type TelemetryConfig,
} from "./types.ts";

export const getConfigDir = CliSettings.useSync((cliSettings) => cliSettings.supabaseHome);

const TelemetryConfigFileSchema = Schema.fromJsonString(TelemetryConfigSchema);
const LegacyTelemetryConfigSchema = Schema.Struct({
  enabled: Schema.Boolean,
  device_id: Schema.String,
  session_id: Schema.String,
  session_last_active: Schema.String,
  distinct_id: Schema.optionalKey(Schema.String),
  schema_version: Schema.optionalKey(PersistedNumberSchema),
});
type LegacyTelemetryConfig = Schema.Schema.Type<typeof LegacyTelemetryConfigSchema>;

const decodeCurrentTelemetryConfigFile = Schema.decodeUnknownEffect(TelemetryConfigFileSchema);
const decodeLegacyTelemetryConfigFile = Schema.decodeUnknownEffect(
  Schema.fromJsonString(LegacyTelemetryConfigSchema),
);
const encodeTelemetryConfig = Schema.encodeEffect(TelemetryConfigSchema);

function encodePrettyJson(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function legacyConsent(enabled: boolean): ConsentState {
  return enabled ? "granted" : "denied";
}

function legacyConfigToTelemetryConfig(
  legacyConfig: LegacyTelemetryConfig,
): TelemetryConfig | undefined {
  const sessionLastActive = Date.parse(legacyConfig.session_last_active);
  if (!Number.isFinite(sessionLastActive)) return undefined;
  return {
    consent: legacyConsent(legacyConfig.enabled),
    device_id: legacyConfig.device_id,
    session_id: legacyConfig.session_id,
    session_last_active: sessionLastActive,
    ...(legacyConfig.distinct_id === undefined ? {} : { distinct_id: legacyConfig.distinct_id }),
  };
}

const decodeTelemetryConfigFile = Effect.fnUntraced(function* (content: string) {
  const config = yield* decodeCurrentTelemetryConfigFile(content).pipe(
    Effect.catch(() =>
      Effect.gen(function* () {
        const legacyConfig = yield* decodeLegacyTelemetryConfigFile(content);
        return yield* Effect.fromNullishOr(legacyConfigToTelemetryConfig(legacyConfig));
      }),
    ),
  );
  const hasIdentity = config.device_id !== "" && config.session_id !== "";
  return yield* Effect.fromNullishOr(hasIdentity ? config : undefined);
});

// A file that cannot be read or decoded may hold an opt-out, so it reads as one.
const optedOutTelemetryConfig = Effect.gen(function* () {
  const crypto = yield* SecureRandom.SecureRandom;
  const config: TelemetryConfig = {
    consent: "denied",
    device_id: yield* crypto.uuidV4(),
    session_id: yield* crypto.uuidV4(),
    session_last_active: yield* Clock.currentTimeMillis,
  };
  return config;
});

export const readTelemetryConfig = Effect.fnUntraced(
  function* (configDir: string) {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const configPath = path.join(configDir, "telemetry.json");
    const content = yield* fs.readFileString(configPath).pipe(
      Effect.catch((error) =>
        error.reason._tag === "NotFound" ? Effect.succeed("") : Effect.fail(error),
      ),
      Effect.option,
    );
    if (Option.isNone(content)) return Option.some(yield* optedOutTelemetryConfig);
    if (content.value.trim().length === 0) return Option.none<TelemetryConfig>();
    const config = yield* decodeTelemetryConfigFile(content.value).pipe(
      Effect.catch(() => optedOutTelemetryConfig),
    );
    return Option.some(config);
  },
  (effect) => Effect.orElseSucceed(effect, () => Option.none<TelemetryConfig>()),
);

/**
 * Replaces `telemetry.json` through a temporary file and a rename. A write interrupted halfway
 * leaves the previous content, where an in-place write would leave an empty file that reads as a
 * first run.
 */
export const publishTelemetryFile = Effect.fnUntraced(function* (
  configPath: string,
  content: string,
  platform: NodeJS.Platform = process.platform,
) {
  const crypto = yield* SecureRandom.SecureRandom;
  const fs = yield* FileSystem.FileSystem;
  // Random suffix, not a timestamp: concurrent writers (parallel test files,
  // two CLI processes) in the same millisecond would otherwise share a tmp
  // path and race the rename into ENOENT.
  const tmpPath = `${configPath}.tmp.${yield* crypto.uuidV4()}`;
  const retrySchedule = Schedule.exponential("10 millis", 2).pipe(
    Schedule.modifyDelay(({ duration }) =>
      Effect.succeed(Duration.min(duration, Duration.millis(100))),
    ),
    Schedule.upTo({ times: 12 }),
  );
  const errorCode = (error: unknown): string | undefined => {
    if (!Predicate.hasProperty(error, "cause")) return undefined;
    return Predicate.hasProperty(error.cause, "code") && typeof error.cause.code === "string"
      ? error.cause.code
      : undefined;
  };
  yield* Effect.acquireUseRelease(
    Effect.succeed(tmpPath),
    (temporary) =>
      Effect.gen(function* () {
        yield* fs.writeFileString(temporary, content, { mode: 0o600 });
        yield* fs.rename(temporary, configPath).pipe(
          Effect.retry({
            schedule: retrySchedule,
            while: (error) =>
              platform === "win32" && ["EPERM", "EACCES", "EBUSY"].includes(errorCode(error) ?? ""),
          }),
          Effect.mapError((cause) => contextualRenameError(cause, configPath, errorCode(cause))),
        );
      }),
    (temporary) => fs.remove(temporary, { force: true }).pipe(Effect.ignore),
  );
});

export const writeTelemetryConfig = Effect.fnUntraced(function* (
  config: TelemetryConfig,
  configDir: string,
  platform: NodeJS.Platform = process.platform,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  yield* fs.makeDirectory(configDir, { recursive: true, mode: 0o700 });
  const encoded = yield* encodeTelemetryConfig(config);
  yield* publishTelemetryFile(
    path.join(configDir, "telemetry.json"),
    encodePrettyJson(encoded),
    platform,
  );
}, Effect.orDie);

function contextualRenameError(
  cause: unknown,
  configPath: string,
  code: string | undefined,
): PlatformError.PlatformError {
  const reason =
    cause instanceof PlatformError.PlatformError &&
    cause.reason instanceof PlatformError.SystemError
      ? cause.reason
      : undefined;
  return PlatformError.systemError({
    _tag: reason?._tag ?? "Unknown",
    module: reason?.module ?? "FileSystem",
    method: reason?.method ?? "rename",
    syscall: reason?.syscall,
    pathOrDescriptor: configPath,
    description: `${reason?.description ? `${reason.description}; ` : ""}Unable to publish telemetry config${code ? ` (${code})` : ""}`,
    cause,
  });
}

export const getEffectiveConsent = Effect.fnUntraced(function* (
  config: Option.Option<TelemetryConfig>,
) {
  const cliSettings = yield* CliSettings;
  const telemetryDisabled = cliSettings.telemetryDisabled;
  if (Option.isSome(telemetryDisabled) && telemetryDisabled.value === "1") {
    return "denied" as const;
  }

  const doNotTrack = cliSettings.doNotTrack;
  if (Option.isSome(doNotTrack) && doNotTrack.value === "1") return "denied" as const;

  return Option.match(config, {
    onNone: () => "granted" as const,
    onSome: (value) => value.consent,
  });
});
