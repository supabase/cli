import { Effect, Option } from "effect";
import { LegacyGoProxy } from "../../../../shared/legacy/go-proxy.service.ts";

interface LegacyBackupsRestoreFlags {
  readonly projectRef: Option.Option<string>;
  readonly timestamp: Option.Option<number>;
}

export const legacyBackupsRestore = Effect.fn("legacy.backups.restore")(function* (
  flags: LegacyBackupsRestoreFlags,
) {
  const proxy = yield* LegacyGoProxy;
  const args: string[] = ["backups", "restore"];
  if (Option.isSome(flags.projectRef)) args.push("--project-ref", flags.projectRef.value);
  if (Option.isSome(flags.timestamp)) args.push("--timestamp", String(flags.timestamp.value));
  yield* proxy.exec(args);
});
