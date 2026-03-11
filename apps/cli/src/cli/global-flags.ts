import { Console, Effect, Option } from "effect";
import { Flag, GlobalFlag } from "effect/unstable/cli";
import type { OutputFormat } from "../output/types.ts";
import { detectAgents } from "../agents/agent-detect.ts";
import { SkillWriter } from "../agents/skill-writer.service.ts";
import { buildSkillEntries } from "../docs/skill-entries.ts";
import { formatAsUsageSpec } from "../docs/usage-formatter.ts";

export const UsageFlag = GlobalFlag.action({
  flag: Flag.boolean("usage").pipe(
    Flag.withDescription("Output CLI spec in usage format (https://usage.jdx.dev) and exit"),
    Flag.withDefault(false),
  ),
  run: (_value, { command, version }) => Console.log(formatAsUsageSpec(command, { version })),
});

export const OutputFormatFlag = GlobalFlag.setting("output-format")({
  flag: Flag.choice("output-format", ["text", "json", "stream-json"]).pipe(
    Flag.withDescription("Output format: text (default), json, or stream-json (NDJSON)"),
    Flag.withDefault("text" as OutputFormat),
  ),
});

export const SkillFlag = GlobalFlag.action({
  flag: Flag.boolean("skill").pipe(
    Flag.withDescription("Auto-detect agents and install CLI skill files"),
    Flag.withDefault(false),
  ),
  run: (_value, { command, commandPath }) =>
    Effect.gen(function* () {
      const detected = detectAgents();
      if (detected.length === 0) {
        yield* Console.error("No agent detected. Use --skill-dir <path> instead.");
        return;
      }
      const skillWriter = yield* SkillWriter;
      const entries = buildSkillEntries(command, commandPath);
      for (const agent of detected) {
        yield* skillWriter.writeSkillFiles(agent.skillsDir, entries);
        yield* Console.log(
          `Installed ${entries.length} skill(s) for ${agent.displayName} (${agent.skillsDir})`,
        );
      }
    }),
});

export const SkillDirFlag = GlobalFlag.action({
  flag: Flag.string("skill-dir").pipe(
    Flag.withDescription("Install CLI skill files to a custom directory"),
    Flag.optional,
  ),
  run: (dirOption, { command, commandPath }) =>
    Effect.gen(function* () {
      if (Option.isNone(dirOption)) return;
      const skillWriter = yield* SkillWriter;
      const entries = buildSkillEntries(command, commandPath);
      yield* skillWriter.writeSkillFiles(dirOption.value, entries);
      yield* Console.log(`Installed ${entries.length} skill(s) to ${dirOption.value}`);
    }),
});
