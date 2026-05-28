import { Effect, Option } from "effect";
import { LegacyGoProxy } from "../../../../shared/legacy/go-proxy.service.ts";
import type { LegacyProjectsCreateFlags } from "./create.command.ts";

export const legacyProjectsCreate = Effect.fn("legacy.projects.create")(function* (
  flags: LegacyProjectsCreateFlags,
) {
  const proxy = yield* LegacyGoProxy;
  const args: string[] = ["projects", "create"];
  if (Option.isSome(flags.name)) args.push(flags.name.value);
  if (Option.isSome(flags.orgId)) args.push("--org-id", flags.orgId.value);
  if (Option.isSome(flags.dbPassword)) args.push("--db-password", flags.dbPassword.value);
  if (Option.isSome(flags.region)) args.push("--region", flags.region.value);
  if (Option.isSome(flags.size)) args.push("--size", flags.size.value);
  if (Option.isSome(flags.highAvailability))
    args.push(`--high-availability=${flags.highAvailability.value ? "true" : "false"}`);
  if (Option.isSome(flags.interactive))
    args.push(`--interactive=${flags.interactive.value ? "true" : "false"}`);
  if (Option.isSome(flags.plan)) args.push("--plan", flags.plan.value);
  yield* proxy.exec(args);
});
