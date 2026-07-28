import { BunServices } from "@effect/platform-bun";
import { Effect, Exit } from "effect";
import { describe, expect, test } from "vitest";
import { legacyNetworkBansRemoveDbUnbanIpFlag } from "./remove.command.ts";

// Go declares `--db-unban-ip` with pflag's `StringSliceVar` (`cmd/bans.go:48`),
// which CSV-splits each occurrence and appends across repeats.
describe("legacy network-bans remove --db-unban-ip flag (pflag StringSlice parity)", () => {
  test("splits a comma-separated value into multiple IPs", async () => {
    const [, ips] = await Effect.runPromise(
      legacyNetworkBansRemoveDbUnbanIpFlag
        .parse({
          flags: { "db-unban-ip": ["12.3.4.5,5.6.7.8"] },
          arguments: [],
        })
        .pipe(Effect.provide(BunServices.layer)),
    );

    expect(ips).toEqual(["12.3.4.5", "5.6.7.8"]);
  });

  test("keeps a quoted value with embedded comma as a single element", async () => {
    const [, ips] = await Effect.runPromise(
      legacyNetworkBansRemoveDbUnbanIpFlag
        .parse({
          flags: { "db-unban-ip": ['"12.3.4.5,5.6.7.8"'] },
          arguments: [],
        })
        .pipe(Effect.provide(BunServices.layer)),
    );

    expect(ips).toEqual(["12.3.4.5,5.6.7.8"]);
  });

  test("defaults to an empty array when unset", async () => {
    const [, ips] = await Effect.runPromise(
      legacyNetworkBansRemoveDbUnbanIpFlag
        .parse({
          flags: {},
          arguments: [],
        })
        .pipe(Effect.provide(BunServices.layer)),
    );

    expect(ips).toEqual([]);
  });

  test("rejects malformed CSV (unterminated quote)", async () => {
    const exit = await Effect.runPromise(
      legacyNetworkBansRemoveDbUnbanIpFlag
        .parse({
          flags: { "db-unban-ip": ['"12.3.4.5'] },
          arguments: [],
        })
        .pipe(Effect.provide(BunServices.layer))
        .pipe(Effect.exit),
    );

    expect(Exit.isFailure(exit)).toBe(true);
  });
});
