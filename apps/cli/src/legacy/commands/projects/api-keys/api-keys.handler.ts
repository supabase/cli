import { Effect, Option } from "effect";
import { LegacyGoProxy } from "../../../../shared/legacy/go-proxy.service.ts";
import type { LegacyProjectsApiKeysFlags } from "./api-keys.command.ts";

export const legacyProjectsApiKeys = Effect.fn("legacy.projects.api-keys")(function* (
  flags: LegacyProjectsApiKeysFlags,
) {
  const proxy = yield* LegacyGoProxy;
  const args: string[] = ["projects", "api-keys"];
  if (Option.isSome(flags.projectRef)) args.push("--project-ref", flags.projectRef.value);
  yield* proxy.exec(args);
});
