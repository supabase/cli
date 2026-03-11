import { Effect } from "effect";
import { listStacks } from "@supabase/stack/internals";
import { CliConfig } from "../../config/cli-config.service.ts";
import { Output } from "../../output/output.service.ts";
import type { StatusFlags } from "./status.command.ts";

export const status = Effect.fnUntraced(function* (_flags: StatusFlags) {
  const output = yield* Output;
  const cliConfig = yield* CliConfig;
  const stacks = yield* listStacks({ home: cliConfig.supabaseHome });

  if (stacks.length === 0) {
    yield* output.info("No local Supabase stacks found.");
    return;
  }

  for (const stack of stacks) {
    const state = stack.alive ? "running" : "stopped";
    yield* output.info(`${stack.name} (${state}) - ${stack.url}`);
  }

  yield* output.success("Stack status", {
    stacks: stacks.map((s) => ({
      name: s.name,
      alive: s.alive,
      pid: s.pid,
      url: s.url,
      db_url: s.dbUrl,
      started_at: s.startedAt,
    })),
  });
});
