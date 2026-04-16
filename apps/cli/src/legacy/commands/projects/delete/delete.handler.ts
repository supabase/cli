import { Effect, Option } from "effect";
import { LegacyGoProxy } from "../../../../shared/legacy/go-proxy.service.ts";
import type { LegacyProjectsDeleteFlags } from "./delete.command.ts";

export const legacyProjectsDelete = Effect.fn("legacy.projects.delete")(function* (
  flags: LegacyProjectsDeleteFlags,
) {
  const proxy = yield* LegacyGoProxy;
  const args: string[] = ["projects", "delete"];
  if (Option.isSome(flags.ref)) args.push(flags.ref.value);
  yield* proxy.exec(args);
});
