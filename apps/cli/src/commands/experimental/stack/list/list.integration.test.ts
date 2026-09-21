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

  it.live("lists healthy stacks and warns about invalid entries without altering state", () =>
    Effect.gen(function* () {
      const fixture = yield* registry();
      const healthy = yield* fixture.api.create({
        ...fixture.locations,
        projectRoot: fixture.root,
        name: "healthy",
        runtime: "native",
      });
      const broken = yield* fixture.api.create({
        ...fixture.locations,
        projectRoot: fixture.root,
        name: "broken",
        runtime: "native",
      });
      const file = fixture.path.join(fixture.locations.stateRoot, broken.id, "state.json");
      yield* fixture.fs.writeFileString(file, "{broken");
      const mismatchRoot = fixture.path.join(fixture.locations.stateRoot, "mismatched");
      yield* fixture.fs.makeDirectory(mismatchRoot);
      const mismatchFile = fixture.path.join(mismatchRoot, "state.json");
      const healthyState = yield* fixture.fs.readFileString(
        fixture.path.join(fixture.locations.stateRoot, healthy.id, "state.json"),
      );
      yield* fixture.fs.writeFileString(mismatchFile, healthyState);
      for (const format of ["text", "json", "stream-json"] as const) {
        const output = mockOutput({ format });
        const entries = yield* stackList().pipe(
          Effect.provide(Layer.mergeAll(fixture.layer, output.layer)),
        );
        expect(entries.map(({ id }) => id)).toEqual([healthy.id]);
        expect(output.stderrText).toContain(`skipping invalid stack ${broken.id}`);
        expect(output.stderrText).toContain("skipping invalid stack mismatched");
        expect(output.stdoutText).not.toContain("Warning");
        if (format !== "text")
          expect(output.messages).toContainEqual(
            expect.objectContaining({ data: { stacks: entries } }),
          );
      }
      expect(yield* fixture.fs.readFileString(file)).toBe("{broken");
      expect(yield* fixture.fs.readFileString(mismatchFile)).toBe(healthyState);
      const discoveryError = yield* fixture.api.discover(fixture.locations).pipe(Effect.flip);
      expect(discoveryError.operation).toBe("discover");
      const openError = yield* fixture.api
        .open({ ...fixture.locations, id: broken.id })
        .pipe(Effect.flip);
      expect(openError.operation).toBe("open");
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
