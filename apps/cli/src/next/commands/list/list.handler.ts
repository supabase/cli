import { Effect } from "effect";
import { listStacks } from "@supabase/stack/effect";
import { CliProjectHome } from "../../config/cli-project-home.service.ts";
import { Output } from "../../../shared/output/output.service.ts";

export const list = Effect.fnUntraced(function* () {
  const output = yield* Output;
  const project = yield* CliProjectHome;
  yield* output.intro("List local Supabase stacks");
  const stacks = yield* listStacks({ projectRoot: project.projectRoot });
  if (stacks.length === 0) {
    const message = "No local Supabase stacks are known for this project.";
    if (output.format === "text") return yield* output.outro(message);
    return yield* output.success(message, { stacks: [] });
  }
  const data = {
    stacks: stacks.map((stack) => ({
      id: stack.id,
      name: stack.name,
      lifecycle: stack.desiredLifecycle,
      runtime: stack.runtime,
      project_root: stack.projectRoot,
    })),
  };
  if (output.format !== "text") return yield* output.success("Known local Supabase stacks.", data);
  yield* output.success("Known local Supabase stacks.");
  for (const stack of stacks) {
    yield* output.info(`${stack.name}: ${stack.desiredLifecycle} (${stack.runtime.kind})`);
  }
  yield* output.outro(
    `Found ${stacks.length} local Supabase stack${stacks.length === 1 ? "" : "s"}.`,
  );
});
