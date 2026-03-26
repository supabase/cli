import { Effect } from "effect";
import { listStacks } from "@supabase/stack/effect";
import { CliConfig } from "../../config/cli-config.service.ts";
import { ProjectHome } from "../../config/project-home.service.ts";
import { Output } from "../../output/output.service.ts";

export const list = Effect.fnUntraced(function* () {
  const output = yield* Output;
  const cliConfig = yield* CliConfig;
  const projectHome = yield* ProjectHome;

  yield* output.intro("List local Supabase stacks");

  const stacks = yield* listStacks({
    cacheRoot: cliConfig.supabaseHome,
    projectStateRoot: projectHome.projectHomeDir,
  });

  if (stacks.length === 0) {
    const message = "No local Supabase stacks are known for this project.";
    if (output.format === "text") {
      yield* output.outro(message);
      return;
    }

    yield* output.success(message, { stacks: [] });
    return;
  }

  const data = {
    stacks: stacks.map((stack) => ({
      name: stack.name,
      running: stack.running,
      ports: stack.ports,
      started_at: stack.startedAt,
    })),
  };

  if (output.format !== "text") {
    yield* output.success("Known local Supabase stacks.", data);
    return;
  }

  yield* output.success("Known local Supabase stacks.");
  for (const stack of stacks) {
    const parts = [
      stack.running ? "running" : "stopped",
      `API ${stack.ports.apiPort}`,
      `DB ${stack.ports.dbPort}`,
    ];
    if (stack.running && stack.startedAt !== undefined) {
      parts.push(`started ${stack.startedAt}`);
    }
    yield* output.info(`${stack.name}: ${parts.join(" | ")}`);
  }
  yield* output.outro(
    `Found ${stacks.length} local Supabase stack${stacks.length === 1 ? "" : "s"}.`,
  );
});
