import { Effect, Option } from "effect";

import { LegacyProjectRefResolver } from "../../../config/legacy-project-ref.service.ts";
import { LegacyOutputFlag } from "../../../../shared/legacy/global-flags.ts";
import { Output } from "../../../../shared/output/output.service.ts";
import {
  encodeEnv,
  encodeGoJson,
  encodeToml,
  encodeYaml,
} from "../../../shared/legacy-go-output.encoders.ts";
import { LegacyLinkedProjectCache } from "../../../telemetry/legacy-linked-project-cache.service.ts";
import { LegacyTelemetryState } from "../../../telemetry/legacy-telemetry-state.service.ts";
import { buildInfoPayload, renderInfoMarkdown } from "../sso.format.ts";
import type { LegacySsoInfoFlags } from "./info.command.ts";

export const legacySsoInfo = Effect.fn("legacy.sso.info")(function* (flags: LegacySsoInfoFlags) {
  const output = yield* Output;
  const goOutputFlag = yield* LegacyOutputFlag;
  const resolver = yield* LegacyProjectRefResolver;
  const linkedProjectCache = yield* LegacyLinkedProjectCache;
  const telemetryState = yield* LegacyTelemetryState;

  yield* Effect.gen(function* () {
    const ref = yield* resolver.resolve(flags.projectRef);

    yield* Effect.gen(function* () {
      const payload = buildInfoPayload(ref);
      const goFmt = Option.getOrUndefined(goOutputFlag);

      if (goFmt === "env") {
        yield* output.raw(encodeEnv(payload) + "\n");
        return;
      }
      if (goFmt === "json") {
        yield* output.raw(encodeGoJson(payload));
        return;
      }
      if (goFmt === "yaml") {
        yield* output.raw(encodeYaml(payload));
        return;
      }
      if (goFmt === "toml") {
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
