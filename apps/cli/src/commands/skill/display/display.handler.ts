import { Effect, Option } from "effect";

import { OutputFlag } from "../../../command-internal/global-flags.ts";
import { unsupportedOutputFlagMessage } from "../../../command-internal/output-formats.ts";
import { CLI_UPGRADE_GUIDE_URL, CLI_VERSION } from "../../../shared/cli/version.ts";
import { Output } from "../../../shared/output/output.service.ts";
import { PropSkillTopic } from "../../../shared/telemetry/event-catalog.ts";
import { recordCommandTelemetry } from "../../../telemetry/command-telemetry-attributes.ts";
import { resolveTopic, topicSlugs } from "../content/topics.ts";
import type { SkillDisplayFlags } from "./display.command.ts";
import {
  SkillDisplayOutputFlagUnsupportedError,
  SkillTopicNotFoundError,
} from "./display.errors.ts";
import { renderTopic } from "./display.render.ts";

export const skillDisplay = Effect.fn("skill.display")(function* (flags: SkillDisplayFlags) {
  const outputFlag = yield* OutputFlag;
  if (Option.isSome(outputFlag)) {
    return yield* new SkillDisplayOutputFlagUnsupportedError({
      message: unsupportedOutputFlagMessage("skill display"),
    });
  }
  const requested = Option.getOrElse(flags.topic, () => "overview");
  const topic = resolveTopic(requested);
  if (Option.isNone(topic)) {
    return yield* new SkillTopicNotFoundError({
      topic: requested,
      available: topicSlugs,
      version: CLI_VERSION,
      message: `Unknown skill topic "${requested}".`,
      suggestion: `Topics in Supabase CLI ${CLI_VERSION}: ${topicSlugs.join(", ")}. If the topic you need is missing, this CLI may be older than your guidance; upgrade: ${CLI_UPGRADE_GUIDE_URL}`,
    });
  }
  yield* Effect.annotateCurrentSpan("skill.topic", topic.value.slug);
  const output = yield* Output;
  const markdown = renderTopic(topic.value, CLI_VERSION);
  if (output.format === "text") {
    yield* output.raw(markdown);
  } else {
    yield* output.result({ markdown });
  }
  yield* recordCommandTelemetry({ [PropSkillTopic]: topic.value.slug });
});
