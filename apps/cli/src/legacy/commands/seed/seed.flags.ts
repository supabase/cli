import { Flag, GlobalFlag } from "effect/unstable/cli";

/**
 * `--linked` / `--local` are declared on the `seed` GROUP as scoped global flags,
 * mirroring Go's `seedCmd.PersistentFlags()` (`apps/cli-go/cmd/seed.go:27-29`):
 * cobra persistent flags are inherited by subcommands and accepted BEFORE or
 * AFTER the subcommand token, so both `supabase seed --linked buckets` and
 * `supabase seed buckets --linked` are valid. Effect CLI's scoped globals give
 * the same semantics — position-independent within the group's subtree and
 * rejected out-of-scope. Declared in a standalone module so the `seed` group and
 * the `buckets` leaf can both import them without a circular dependency.
 *
 * Go's `--local` default is `true` (`seed.go:29`); the seed target is actually
 * selected from the changed-flag set (Go's `flag.Changed`, see
 * `buckets.flags.ts`), not these parsed values, so the defaults only affect the
 * help text and the telemetry flags map.
 */
export const LegacySeedLinkedFlag = GlobalFlag.setting("linked")({
  flag: Flag.boolean("linked").pipe(Flag.withDescription("Seeds the linked project.")),
});

export const LegacySeedLocalFlag = GlobalFlag.setting("local")({
  flag: Flag.boolean("local").pipe(
    Flag.withDescription("Seeds the local database."),
    Flag.withDefault(true),
  ),
});
