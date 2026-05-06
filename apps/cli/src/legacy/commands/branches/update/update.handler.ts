import { Effect, Option } from "effect";
import { LegacyGoProxy } from "../../../../shared/legacy/go-proxy.service.ts";

type BranchStatus =
  | "RUNNING_MIGRATIONS"
  | "MIGRATIONS_PASSED"
  | "MIGRATIONS_FAILED"
  | "FUNCTIONS_DEPLOYED"
  | "FUNCTIONS_FAILED";

interface LegacyBranchesUpdateFlags {
  readonly branchId: Option.Option<string>;
  readonly projectRef: Option.Option<string>;
  readonly name: Option.Option<string>;
  readonly gitBranch: Option.Option<string>;
  readonly persistent: boolean;
  readonly status: Option.Option<BranchStatus>;
  readonly notifyUrl: Option.Option<string>;
}

export const legacyBranchesUpdate = Effect.fn("legacy.branches.update")(function* (
  flags: LegacyBranchesUpdateFlags,
) {
  const proxy = yield* LegacyGoProxy;
  const args: string[] = ["branches", "update"];
  if (Option.isSome(flags.branchId)) args.push(flags.branchId.value);
  if (Option.isSome(flags.projectRef)) args.push("--project-ref", flags.projectRef.value);
  if (Option.isSome(flags.name)) args.push("--name", flags.name.value);
  if (Option.isSome(flags.gitBranch)) args.push("--git-branch", flags.gitBranch.value);
  if (flags.persistent) args.push("--persistent");
  if (Option.isSome(flags.status)) args.push("--status", flags.status.value);
  if (Option.isSome(flags.notifyUrl)) args.push("--notify-url", flags.notifyUrl.value);
  yield* proxy.exec(args);
});
