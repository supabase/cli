import { Effect, Layer } from "effect";
import {
  feedbackClientLayer,
  legacyFeedbackEnvironment,
} from "../../../shared/feedback/feedback-client.layer.ts";
import { legacyCliConfigLayer } from "../../config/legacy-cli-config.layer.ts";
import { LegacyCliConfig } from "../../config/legacy-cli-config.service.ts";
import { legacyDebugLoggerLayer } from "../../shared/legacy-debug-logger.layer.ts";

export const legacyFeedbackCliConfigLayer = legacyCliConfigLayer.pipe(
  Layer.provide(legacyDebugLoggerLayer),
);

export const legacyFeedbackClientLayer = Layer.unwrap(
  Effect.gen(function* () {
    const config = yield* LegacyCliConfig;
    return feedbackClientLayer({ environment: legacyFeedbackEnvironment(config.profile) });
  }),
).pipe(Layer.provide(legacyFeedbackCliConfigLayer));
