import { Effect } from "effect";
import { LegacyGoProxy } from "../../../../shared/legacy/go-proxy.service.ts";
import type { LegacyProjectsListFlags } from "./list.command.ts";

export const legacyProjectsList = Effect.fn("legacy.projects.list")(function* (
  _flags: LegacyProjectsListFlags,
) {
  const proxy = yield* LegacyGoProxy;
  yield* proxy.exec(["projects", "list"]);
});
