import { Flag, GlobalFlag } from "effect/unstable/cli";

/**
 * `--linked` / `--local` are scoped global flags on the `seed` group, so both
 * `supabase seed --linked buckets` and `supabase seed buckets --linked` work.
 * `--local` defaults to `true`, but the seed target is actually selected from
 * the changed-flag set (`buckets.flags.ts`), not these parsed values — the
 * defaults only affect help text and the telemetry flags map.
 */
export const SeedLinkedFlag = GlobalFlag.Setting("linked")({
  flag: Flag.Boolean("linked").pipe(
    Flag.withDescription("Seeds the linked project."),
    Flag.withDefault(false),
  ),
});

export const SeedLocalFlag = GlobalFlag.Setting("local")({
  flag: Flag.Boolean("local").pipe(
    Flag.withDescription("Seeds the local database."),
    Flag.withDefault(true),
  ),
});
