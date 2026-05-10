import { describe, expect, it } from "@effect/vitest";
import { Effect, Layer, Option } from "effect";
import { LegacyGoProxy } from "../../../../../../shared/legacy/go-proxy.service.ts";
import type { LegacyDbSchemaDeclarativeSyncFlags } from "./sync.command.ts";
import { legacyDbSchemaDeclarativeSync } from "./sync.handler.ts";

function mockLegacyGoProxy() {
  const calls: string[][] = [];
  return {
    layer: Layer.succeed(LegacyGoProxy, {
      exec: (args: ReadonlyArray<string>) =>
        Effect.sync(() => {
          calls.push([...args]);
        }),
    }),
    get calls() {
      return calls;
    },
  };
}

const baseFlags: LegacyDbSchemaDeclarativeSyncFlags = {
  noCache: false,
  schema: [],
  file: Option.none(),
  name: Option.none(),
  apply: false,
  noApply: false,
};

describe("legacyDbSchemaDeclarativeSync", () => {
  it.live("forwards --no-apply to the Go binary", () => {
    const go = mockLegacyGoProxy();
    return Effect.gen(function* () {
      yield* legacyDbSchemaDeclarativeSync({ ...baseFlags, noApply: true });
      expect(go.calls).toEqual([
        ["db", "schema", "declarative", "sync", "--no-apply"],
      ]);
    }).pipe(Effect.provide(go.layer));
  });

  it.live("default invocation omits --apply and --no-apply", () => {
    const go = mockLegacyGoProxy();
    return Effect.gen(function* () {
      yield* legacyDbSchemaDeclarativeSync({ ...baseFlags });
      expect(go.calls).toEqual([["db", "schema", "declarative", "sync"]]);
    }).pipe(Effect.provide(go.layer));
  });

  it.live("forwards only --apply when set", () => {
    const go = mockLegacyGoProxy();
    return Effect.gen(function* () {
      yield* legacyDbSchemaDeclarativeSync({ ...baseFlags, apply: true });
      expect(go.calls).toEqual([
        ["db", "schema", "declarative", "sync", "--apply"],
      ]);
    }).pipe(Effect.provide(go.layer));
  });

  it.live("combines --no-apply with --name and --schema in argv order", () => {
    const go = mockLegacyGoProxy();
    return Effect.gen(function* () {
      yield* legacyDbSchemaDeclarativeSync({
        ...baseFlags,
        schema: ["public"],
        name: Option.some("foo"),
        noApply: true,
      });
      expect(go.calls).toEqual([
        ["db", "schema", "declarative", "sync", "--schema", "public", "--name", "foo", "--no-apply"],
      ]);
    }).pipe(Effect.provide(go.layer));
  });
});
