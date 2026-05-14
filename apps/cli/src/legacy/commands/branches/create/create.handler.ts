import { Effect, Option } from "effect";
import { LegacyGoProxy } from "../../../../shared/legacy/go-proxy.service.ts";
import type { LegacyBranchesCreateFlags } from "./create.command.ts";

export const legacyBranchesCreate = Effect.fn("legacy.branches.create")(function* (
  flags: LegacyBranchesCreateFlags,
) {
  const proxy = yield* LegacyGoProxy;
  const args: string[] = ["branches", "create"];
  if (Option.isSome(flags.name)) args.push(flags.name.value);
  if (Option.isSome(flags.projectRef)) args.push("--project-ref", flags.projectRef.value);
  if (Option.isSome(flags.region)) args.push("--region", flags.region.value);
  if (Option.isSome(flags.size)) args.push("--size", flags.size.value);
  if (flags.persistent) args.push("--persistent");
  if (flags.withData) args.push("--with-data");
  if (Option.isSome(flags.notifyUrl)) args.push("--notify-url", flags.notifyUrl.value);
  if (Option.isSome(flags.gitBranch)) args.push("--git-branch", flags.gitBranch.value);
  yield* proxy.exec(args);
});
