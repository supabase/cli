import { Effect, Option } from "effect";

import { resolveProjectTarget } from "../../../command-internal/target/resolve-project-target.ts";
import { OutputFlag } from "../../../command-internal/global-flags.ts";
import { Output } from "../../../shared/output/output.service.ts";
import {
  encodeEnv,
  encodeSortedJson,
  encodeToml,
  encodeYaml,
} from "../../../command-internal/output.encoders.ts";
import { LinkedProjectCache } from "../../../telemetry/linked-project-cache.service.ts";
import { TelemetryState } from "../../../telemetry/telemetry-state.service.ts";
import { buildInfoPayload, renderInfoMarkdown } from "../sso.format.ts";
import type { SsoInfoFlags } from "./info.command.ts";

export const ssoInfo = Effect.fn("sso.info")(function* (flags: SsoInfoFlags) {
  const output = yield* Output;
  const outputFlag = yield* OutputFlag;
  const linkedProjectCache = yield* LinkedProjectCache;
  const telemetryState = yield* TelemetryState;

  yield* Effect.gen(function* () {
    const ref = yield* resolveProjectTarget({ remote: flags.remote, projectRef: flags.projectRef });

    yield* Effect.gen(function* () {
      const payload = buildInfoPayload(ref);
      const outputFlagFormat = Option.getOrUndefined(outputFlag);

      if (outputFlagFormat === "env") {
        yield* output.raw(encodeEnv(payload) + "\n");
        return;
      }
      if (outputFlagFormat === "json") {
        yield* output.raw(encodeSortedJson(payload));
        return;
      }
      if (outputFlagFormat === "yaml") {
        yield* output.raw(encodeYaml(payload));
        return;
      }
      if (outputFlagFormat === "toml") {
        yield* output.raw(encodeToml(payload) + "\n");
        return;
      }

      if (output.format === "json" || output.format === "stream-json") {
        yield* output.success("", { ...payload });
        return;
      }

      yield* output.raw(renderInfoMarkdown(ref));
    }).pipe(Effect.ensuring(linkedProjectCache.cache(ref)));
  }).pipe(Effect.ensuring(telemetryState.flush));
});
