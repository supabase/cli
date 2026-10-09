import { note } from "@clack/prompts";
import { Config, Crypto, Effect, Layer, Option } from "effect";
import { CLI_VERSION } from "../cli/version.ts";
import { RuntimeInfo } from "../runtime/runtime-info.service.ts";
import { Tty } from "../runtime/tty.service.ts";
import { getConfigDir, getEffectiveConsent, readTelemetryConfig } from "./consent.ts";
import { makeTelemetryIdentity, resolveIdentity } from "./identity.ts";
import { TelemetryRuntime } from "./runtime.service.ts";

const CI_ENV_VARS = ["CI", "GITHUB_ACTIONS", "GITLAB_CI", "CIRCLECI", "JENKINS_URL", "BUILDKITE"];

/** Whether a well-known CI provider variable is set. */
export const detectCi = Effect.gen(function* () {
  for (const envVar of CI_ENV_VARS) {
    if (Option.isSome(yield* Config.option(Config.String(envVar)))) return true;
  }
  return false;
});

export const telemetryRuntimeLayer = Layer.effect(
  TelemetryRuntime,
  Effect.gen(function* () {
    const crypto = yield* Crypto.Crypto;
    const configDir = yield* getConfigDir;
    const tty = yield* Tty;
    const runtimeInfo = yield* RuntimeInfo;

    const config = yield* readTelemetryConfig(configDir);
    const isTty = tty.stdoutIsTty;
    const consent = yield* getEffectiveConsent(config);

    let identity: {
      readonly deviceId: string;
      readonly sessionId: string;
      readonly distinctId: string | undefined;
      readonly isFirstRun: boolean;
    };
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
      if (Option.isSome(config)) {
        identity = {
          deviceId: config.value.device_id,
          sessionId: config.value.session_id,
          distinctId: config.value.distinct_id,
          isFirstRun: false,
        };
      } else {
        identity = {
          deviceId: yield* crypto.randomUUIDv4,
          sessionId: yield* crypto.randomUUIDv4,
          distinctId: undefined,
          isFirstRun: false,
        };
      }
    }

    const isCi = yield* detectCi;

    return TelemetryRuntime.of({
      configDir,
      consent,
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
