import { Effect, Option } from "effect";

import { OutputFlag } from "../../../command-internal/global-flags.ts";
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
      message: "skill display always prints markdown; -o/--output is not supported.",
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
      suggestion: `Topics in Supabase CLI ${CLI_VERSION}: ${topicSlugs.join(", ")}. Run \`supabase skill display\` for the index. If the topic you need is missing, this CLI may be older than your guidance; upgrade: ${CLI_UPGRADE_GUIDE_URL}`,
    });
  }
  yield* Effect.annotateCurrentSpan("skill.topic", topic.value.slug);
  yield* recordCommandTelemetry({ [PropSkillTopic]: topic.value.slug });
  const output = yield* Output;
  yield* output.raw(renderTopic(topic.value, CLI_VERSION));
});
