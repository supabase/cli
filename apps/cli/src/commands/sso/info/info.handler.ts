import { Effect, Option } from "effect";

import { ProjectRefResolver } from "../../../config/project-ref.service.ts";
import { OutputFlag } from "../../../command-internal/global-flags.ts";
import { Output } from "../../../shared/output/output.service.ts";
import {
  encodeEnv,
  encodeGoJson,
  encodeToml,
  encodeYaml,
} from "../../../command-internal/go-output.encoders.ts";
import { LinkedProjectCache } from "../../../telemetry/linked-project-cache.service.ts";
import { TelemetryState } from "../../../telemetry/telemetry-state.service.ts";
import { buildInfoPayload, renderInfoMarkdown } from "../sso.format.ts";
import type { SsoInfoFlags } from "./info.command.ts";

export const ssoInfo = Effect.fn("sso.info")(function* (flags: SsoInfoFlags) {
  const output = yield* Output;
  const goOutputFlag = yield* OutputFlag;
  const resolver = yield* ProjectRefResolver;
  const linkedProjectCache = yield* LinkedProjectCache;
  const telemetryState = yield* TelemetryState;

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
