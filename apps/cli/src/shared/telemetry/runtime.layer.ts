import { note } from "@clack/prompts";
import { Config, Crypto, Effect, Layer, Option, Path } from "effect";
import { CliConfig } from "../../next/config/cli-config.service.ts";
import { CLI_VERSION } from "../cli/version.ts";
import { RuntimeInfo } from "../runtime/runtime-info.service.ts";
import { Tty } from "../runtime/tty.service.ts";
import { getConfigDir, getEffectiveConsent, readTelemetryConfig } from "./consent.ts";
import { makeTelemetryIdentity, resolveIdentity } from "./identity.ts";
import type { TelemetryConfig } from "./types.ts";
import { TelemetryRuntime } from "./runtime.service.ts";

const CI_ENV_VARS = ["CI", "GITHUB_ACTIONS", "GITLAB_CI", "CIRCLECI", "JENKINS_URL", "BUILDKITE"];

const identityFromConfig = (config: Option.Option<TelemetryConfig>) =>
  Effect.gen(function* () {
    if (Option.isSome(config)) {
      return {
        deviceId: config.value.device_id,
        sessionId: config.value.session_id,
        distinctId: config.value.distinct_id,
        isFirstRun: false,
      } as const;
    }

    const crypto = yield* Crypto.Crypto;
    return {
      deviceId: yield* crypto.randomUUIDv4,
      sessionId: yield* crypto.randomUUIDv4,
      distinctId: undefined,
      isFirstRun: false,
    } as const;
  });

export const telemetryRuntimeLayer = Layer.effect(
  TelemetryRuntime,
  Effect.gen(function* () {
    const cliConfig = yield* CliConfig;
    const path = yield* Path.Path;
    const configDir = yield* getConfigDir;
    const tracesDir = path.join(configDir, "traces");
    const tty = yield* Tty;
    const runtimeInfo = yield* RuntimeInfo;

    const config = yield* readTelemetryConfig(configDir);
    const isTty = tty.stdoutIsTty;
    const consent = yield* getEffectiveConsent(config);

    let identity;
    if (consent === "granted") {
      if (Option.isNone(config) && isTty) {
        yield* Effect.sync(() =>
          note(
            "Supabase collects anonymous usage data to improve the CLI.\nYou can opt out at any time:\n\n  supabase telemetry disable\n\nLearn more: https://supabase.com/docs/guides/local-development/cli/getting-started#telemetry",
            "Telemetry",
          ),
        );
      }
      identity = yield* resolveIdentity(configDir);
    } else {
      identity = yield* identityFromConfig(config);
    }

    const showDebug =
      (Option.isSome(cliConfig.debug) && cliConfig.debug.value === "1") ||
      (Option.isSome(cliConfig.telemetryDebug) && cliConfig.telemetryDebug.value === "1");

    const ciValues = yield* Effect.all(
      CI_ENV_VARS.map((envVar) => Config.option(Config.string(envVar))),
    );
    const isCi = ciValues.some(Option.isSome);

    return TelemetryRuntime.of({
      configDir,
      tracesDir,
      consent,
      showDebug,
      deviceId: identity.deviceId,
      sessionId: identity.sessionId,
      identity: makeTelemetryIdentity(identity.distinctId),
      isFirstRun: identity.isFirstRun,
      isTty,
      isCi,
      os: runtimeInfo.platform,
      arch: runtimeInfo.arch,
      cliVersion: CLI_VERSION,
    });
  }),
);
