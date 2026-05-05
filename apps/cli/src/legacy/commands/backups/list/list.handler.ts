import { Effect, Option } from "effect";
import { LegacyGoProxy } from "../../../../shared/legacy/go-proxy.service.ts";

interface LegacyBackupsListFlags {
  readonly projectRef: Option.Option<string>;
}

export const legacyBackupsList = Effect.fn("legacy.backups.list")(function* (
  flags: LegacyBackupsListFlags,
) {
  const proxy = yield* LegacyGoProxy;
  const args: string[] = ["backups", "list"];
  if (Option.isSome(flags.projectRef)) args.push("--project-ref", flags.projectRef.value);
  yield* proxy.exec(args);
});
