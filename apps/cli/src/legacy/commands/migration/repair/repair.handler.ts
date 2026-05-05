import { Effect, Option } from "effect";
import { LegacyGoProxy } from "../../../../shared/legacy/go-proxy.service.ts";

interface LegacyMigrationRepairInput {
  readonly versions: ReadonlyArray<string>;
  readonly status: "applied" | "reverted";
  readonly dbUrl: Option.Option<string>;
  readonly linked: boolean;
  readonly local: boolean;
  readonly password: Option.Option<string>;
}

export const legacyMigrationRepair = Effect.fn("legacy.migration.repair")(function* (
  flags: LegacyMigrationRepairInput,
) {
  const proxy = yield* LegacyGoProxy;
  const args: string[] = ["migration", "repair"];
  args.push(...flags.versions);
  args.push("--status", flags.status);
  if (Option.isSome(flags.dbUrl)) args.push("--db-url", flags.dbUrl.value);
  if (flags.linked) args.push("--linked");
  if (flags.local) args.push("--local");
  if (Option.isSome(flags.password)) args.push("--password", flags.password.value);
  yield* proxy.exec(args);
});
