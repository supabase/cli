import { Effect, Option } from "effect";
import { LegacyGoProxy } from "../../../shared/legacy/go-proxy.service.ts";
import type { LegacyStopFlags } from "./stop.command.ts";

export const legacyStop = Effect.fn("legacy.stop")(function* (flags: LegacyStopFlags) {
  const proxy = yield* LegacyGoProxy;
  const args: string[] = ["stop"];
  if (Option.isSome(flags.projectId)) args.push("--project-id", flags.projectId.value);
  // `--backup` defaults to true; only forward when explicitly disabled, which
  // matches the Go CLI semantics (`!noBackup` && `--backup=false`).
  if (!flags.backup) args.push("--backup=false");
  if (flags.noBackup) args.push("--no-backup");
  if (flags.all) args.push("--all");
  yield* proxy.exec(args);
});
