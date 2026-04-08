import { Effect } from "effect";
import { Command } from "effect/unstable/cli";
import { Output } from "../../output/output.service.ts";
import { withJsonErrorHandling } from "../../output/json-error-handling.ts";
import { commandRuntimeLayer } from "../../runtime/command-runtime.layer.ts";
import { withCommandInstrumentation } from "../../telemetry/command-instrumentation.ts";
import {
  getConfigDir,
  getEffectiveConsent,
  readTelemetryConfig,
  writeTelemetryConfig,
} from "../../telemetry/consent.ts";
import { resolveIdentity } from "../../telemetry/identity.ts";

const enableTelemetry = Effect.gen(function* () {
  const output = yield* Output;
  const configDir = yield* getConfigDir;
  const identity = yield* resolveIdentity(configDir);

  yield* writeTelemetryConfig(
    {
      consent: "granted",
      device_id: identity.deviceId,
      session_id: identity.sessionId,
      session_last_active: Date.now(),
      ...(identity.distinctId === undefined ? {} : { distinct_id: identity.distinctId }),
    },
    configDir,
  );
  yield* output.success("Telemetry enabled.", { consent: "granted" });
});

const disableTelemetry = Effect.gen(function* () {
  const output = yield* Output;
  const configDir = yield* getConfigDir;
  const identity = yield* resolveIdentity(configDir);

  yield* writeTelemetryConfig(
    {
      consent: "denied",
      device_id: identity.deviceId,
      session_id: identity.sessionId,
      session_last_active: Date.now(),
      ...(identity.distinctId === undefined ? {} : { distinct_id: identity.distinctId }),
    },
    configDir,
  );
  yield* output.success("Telemetry disabled.", { consent: "denied" });
});

const telemetryStatus = Effect.gen(function* () {
  const output = yield* Output;
  const configDir = yield* getConfigDir;
  const config = yield* readTelemetryConfig(configDir);
  const effectiveConsent = yield* getEffectiveConsent(config);

  yield* output.success(`Telemetry is ${effectiveConsent}.`, {
    consent: effectiveConsent,
    config_path: `${configDir}/telemetry.json`,
    persisted_consent: config?.consent ?? null,
  });
});

const telemetryEnableCommand = Command.make("enable").pipe(
  Command.withDescription("Enable CLI telemetry."),
  Command.withShortDescription("Enable telemetry"),
  Command.withHandler(() =>
    enableTelemetry.pipe(withCommandInstrumentation({ analytics: false }), withJsonErrorHandling),
  ),
  Command.provide(commandRuntimeLayer(["telemetry", "enable"])),
);

const telemetryDisableCommand = Command.make("disable").pipe(
  Command.withDescription("Disable CLI telemetry."),
  Command.withShortDescription("Disable telemetry"),
  Command.withHandler(() =>
    disableTelemetry.pipe(withCommandInstrumentation({ analytics: false }), withJsonErrorHandling),
  ),
  Command.provide(commandRuntimeLayer(["telemetry", "disable"])),
);

const telemetryStatusCommand = Command.make("status").pipe(
  Command.withDescription("Show the effective CLI telemetry state."),
  Command.withShortDescription("Show telemetry status"),
  Command.withHandler(() =>
    telemetryStatus.pipe(withCommandInstrumentation(), withJsonErrorHandling),
  ),
  Command.provide(commandRuntimeLayer(["telemetry", "status"])),
);

export const telemetryCommand = Command.make("telemetry").pipe(
  Command.withDescription("Manage CLI telemetry settings."),
  Command.withShortDescription("Manage telemetry"),
  Command.withSubcommands([
    telemetryEnableCommand,
    telemetryDisableCommand,
    telemetryStatusCommand,
  ]),
);
