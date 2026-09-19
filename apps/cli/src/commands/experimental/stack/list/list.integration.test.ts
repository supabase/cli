import { BunServices } from "@effect/platform-bun";
import { describe, expect, it } from "@effect/vitest";
import { Effect, FileSystem, Layer, Option, Path } from "effect";
import { OutputFlag } from "../../../../command-internal/global-flags.ts";
import {
  mockCommandSettings,
  mockTelemetryStateTracked,
} from "../../../../../tests/helpers/command-mocks.ts";
import { mockOutput } from "../../../../../tests/helpers/mocks.ts";
import { StackApi, stackApiLayer } from "../stack.shared.ts";
import { stackList } from "./list.handler.ts";
import { StackCommandListError } from "./list.errors.ts";

const registry = Effect.fn("StackListTest.registry")(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = yield* fs
    .makeTempDirectoryScoped({ prefix: "stack-list-" })
    .pipe(Effect.flatMap(fs.realPath));
  const api = yield* StackApi;
  const locations = { stateRoot: path.join(root, "stacks"), cacheRoot: path.join(root, "cache") };
  const telemetry = mockTelemetryStateTracked();
  const layer = Layer.mergeAll(
    mockCommandSettings({ workdir: root, supabaseHome: root }),
    telemetry.layer,
  );
  return { root, api, fs, path, locations, telemetry, layer };
});

const live = Layer.provideMerge(stackApiLayer, BunServices.layer);

describe("stack list", () => {
  it.live("lists real saved identities without starting owners in text and machine output", () =>
    Effect.gen(function* () {
      const fixture = yield* registry();
      for (const name of ["beta", "alpha"]) {
        yield* fixture.api.create({
          ...fixture.locations,
          projectRoot: fixture.root,
          name,
          runtime: "native",
        });
      }
      for (const format of ["text", "json", "stream-json"] as const) {
        const output = mockOutput({ format });
        const entries = yield* stackList().pipe(
          Effect.provide(Layer.mergeAll(fixture.layer, output.layer)),
        );
        expect(entries.map(({ name }) => name)).toEqual(["alpha", "beta"]);
        expect(entries.every(({ owner }) => owner === "unavailable")).toBe(true);
        expect(entries.every(({ project_root }) => project_root === fixture.root)).toBe(true);
        if (format === "text") {
          expect(output.stdoutText).toContain("OWNER");
          expect(output.stdoutText).toContain("unavailable");
        } else
          expect(output.messages).toContainEqual(
            expect.objectContaining({ data: { stacks: entries } }),
          );
      }
      const discovered = yield* fixture.api.discover(fixture.locations);
      expect(discovered.every(({ host }) => host === undefined)).toBe(true);
      expect(fixture.telemetry.flushed).toBe(true);
    }).pipe(Effect.provide(live)),
  );

  it.live("fails on corrupt saved state without emitting a partial list", () =>
    Effect.gen(function* () {
      const fixture = yield* registry();
      const stack = yield* fixture.api.create({
        ...fixture.locations,
        projectRoot: fixture.root,
        runtime: "native",
      });
      yield* fixture.fs.writeFileString(
        fixture.path.join(fixture.locations.stateRoot, stack.id, "state.json"),
        "{broken",
      );
      const output = mockOutput();
      const error = yield* stackList().pipe(
        Effect.provide(Layer.mergeAll(fixture.layer, output.layer)),
        Effect.flip,
      );
      expect(error).toBeInstanceOf(StackCommandListError);
      expect(error.reason).toBe("invalid-config");
      expect(output.stdoutText).toBe("");
      expect(output.messages).toEqual([]);
      expect(fixture.telemetry.flushed).toBe(true);
    }).pipe(Effect.provide(live)),
  );

  it.live("reports an empty registry and rejects the legacy output flag", () =>
    Effect.gen(function* () {
      const fixture = yield* registry();
      const output = mockOutput();
      yield* stackList().pipe(Effect.provide(Layer.mergeAll(fixture.layer, output.layer)));
      expect(output.stdoutText).toBe("No managed stacks found.\n");
      const error = yield* stackList().pipe(
        Effect.provide(
          Layer.mergeAll(
            fixture.layer,
            output.layer,
            Layer.succeed(OutputFlag, Option.some("json")),
          ),
        ),
        Effect.flip,
      );
      expect(error.reason).toBe("flags");
      expect(fixture.telemetry.flushCount).toBe(2);
    }).pipe(Effect.provide(live)),
  );
});
