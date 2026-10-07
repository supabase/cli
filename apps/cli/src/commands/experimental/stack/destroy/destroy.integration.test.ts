import { BunServices } from "@effect/platform-bun";
import { describe, expect, it } from "@effect/vitest";
import { StackError } from "@supabase/stack/effect";
import { Effect, FileSystem, Layer, Option, Path } from "effect";
import { CliArgs } from "../../../../shared/cli/cli-args.service.ts";
import { YesFlag } from "../../../../command-internal/global-flags.ts";
import {
  mockCommandSettings,
  mockTelemetryStateTracked,
} from "../../../../../tests/helpers/command-mocks.ts";
import { mockOutput, mockStdin, mockTty } from "../../../../../tests/helpers/mocks.ts";
import { StackApi, stackApiLayer, stackTargetResolverLayer } from "../stack.shared.ts";
import { stackDestroy } from "./destroy.handler.ts";

const live = Layer.provideMerge(stackApiLayer, BunServices.layer);
const fixture = Effect.fn("StackDestroyTest.fixture")(function* (
  yes: boolean,
  confirm?: { readonly answer: boolean },
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = yield* fs.makeTempDirectoryScoped({ prefix: "stack-destroy-" });
  const projectRoot = yield* fs.realPath(root);
  const api = yield* StackApi;
  const locations = { stateRoot: path.join(root, "stacks"), cacheRoot: path.join(root, "cache") };
  const stack = yield* api.create({ ...locations, projectRoot: root, runtime: "native" });
  const output = mockOutput(
    confirm === undefined
      ? { interactive: false }
      : { interactive: true, promptConfirmResponses: [confirm.answer] },
  );
  const telemetry = mockTelemetryStateTracked();
  const settings = mockCommandSettings({ workdir: root, supabaseHome: root });
  const layer = Layer.mergeAll(
    output.layer,
    telemetry.layer,
    settings,
    stackTargetResolverLayer.pipe(Layer.provide(settings)),
    mockTty({ stdinIsTty: confirm !== undefined }),
    mockStdin(false),
    Layer.succeed(YesFlag, yes),
    Layer.succeed(CliArgs, { args: yes ? ["--yes"] : ["--yes=false"] }),
  );
  return {
    root,
    projectRoot,
    fs,
    path,
    api,
    locations,
    stack,
    output,
    telemetry,
    layer,
    flags: { stack: Option.none<string>(), stackId: Option.some(stack.id) },
  };
});

describe("stack destroy", () => {
  it.live("requires confirmation before starting an owner or changing saved state", () =>
    Effect.gen(function* () {
      const f = yield* fixture(false);
      const error = yield* stackDestroy(f.flags).pipe(Effect.provide(f.layer), Effect.flip);
      expect(error.reason).toBe("confirmation");
      const saved = yield* f.api.discover(f.locations);
      expect(saved.map(({ definition }) => definition.id)).toEqual([f.stack.id]);
      expect(saved[0]?.host).toBeUndefined();
      expect(f.telemetry.flushed).toBe(true);
    }).pipe(Effect.provide(live)),
  );

  it.live("asks on an interactive terminal and keeps the stack when declined", () =>
    Effect.gen(function* () {
      const f = yield* fixture(false, { answer: false });
      const error = yield* stackDestroy(f.flags).pipe(Effect.provide(f.layer), Effect.flip);
      expect(error.reason).toBe("cancelled");
      expect(f.output.promptConfirmCalls.map(({ message }) => message)).toEqual([
        `Permanently destroy stack ${f.stack.id} at ${f.projectRoot} and its owned data? Storage upload files will be preserved.`,
      ]);
      const saved = yield* f.api.discover(f.locations);
      expect(saved.map(({ definition }) => definition.id)).toEqual([f.stack.id]);
    }).pipe(Effect.provide(live)),
  );

  it.live("destroys an offline namespace without affecting a different stack", () =>
    Effect.gen(function* () {
      const f = yield* fixture(true);
      const other = yield* f.api.create({
        ...f.locations,
        projectRoot: f.root,
        name: "other",
        runtime: "native",
      });
      yield* Effect.acquireUseRelease(
        Effect.succeed(f.stack),
        () => stackDestroy(f.flags).pipe(Effect.provide(f.layer)),
        () =>
          f.api
            .discover(f.locations)
            .pipe(
              Effect.flatMap((entries) =>
                entries.some(
                  ({ definition, host }) => definition.id === f.stack.id && host !== undefined,
                )
                  ? f.stack.stop
                  : Effect.void,
              ),
            ),
      );
      expect((yield* f.api.discover(f.locations)).map(({ definition }) => definition.id)).toEqual([
        other.id,
      ]);
      expect(f.output.stderrText).toContain(
        `Permanently destroying stack ${f.stack.id} at ${f.projectRoot} and its owned data. Storage upload files will be preserved.\n`,
      );
      expect(f.output.stderrText).not.toContain("[y/N]");
      expect(f.output.promptConfirmCalls).toEqual([]);
      expect(f.output.stdoutText).toContain(`Stack ${f.stack.id} destroyed.`);
      expect(f.telemetry.flushed).toBe(true);
    }).pipe(Effect.provide(live)),
  );

  it.live("destroys only the stack addressed by the short ID that stack list shows", () =>
    Effect.gen(function* () {
      const f = yield* fixture(true);
      const other = yield* f.api.create({
        ...f.locations,
        projectRoot: f.root,
        name: "other",
        runtime: "native",
      });

      yield* stackDestroy({ ...f.flags, stackId: Option.some(f.stack.id.slice(0, 8)) }).pipe(
        Effect.provide(f.layer),
      );

      expect((yield* f.api.discover(f.locations)).map(({ definition }) => definition.id)).toEqual([
        other.id,
      ]);
      expect(f.output.stdoutText).toContain(`Stack ${f.stack.id} destroyed.`);
    }).pipe(Effect.provide(live)),
  );

  it.live("dispatches a full ID with no registration to its deleted-stack cleanup", () =>
    Effect.gen(function* () {
      const f = yield* fixture(true);
      const id = "d".repeat(64);
      let destroyed = 0;
      const api = Layer.succeed(StackApi, {
        ...f.api,
        findDeleted: (options) =>
          Effect.succeed(
            options.id === id
              ? Option.some({
                  id,
                  destroy: Effect.sync(() => {
                    destroyed += 1;
                    return { runtimeCleanup: "complete" } as const;
                  }),
                })
              : Option.none(),
          ),
      });

      yield* stackDestroy({ ...f.flags, stackId: Option.some(id) }).pipe(
        Effect.provide(Layer.merge(f.layer, api)),
      );

      expect(destroyed).toBe(1);
      expect(f.output.stderrText).toContain(
        `Permanently destroying the containers deleted stack ${id} left behind. Storage upload files will be preserved.\n`,
      );
      expect(f.output.stdoutText).toContain(`Removed the containers stack ${id} left behind.`);
      expect((yield* f.api.discover(f.locations)).map(({ definition }) => definition.id)).toEqual([
        f.stack.id,
      ]);
    }).pipe(Effect.provide(live)),
  );

  it.live("reports a full ID as not found, with the engine that could not be searched", () =>
    Effect.gen(function* () {
      const f = yield* fixture(true);
      const id = "d".repeat(64);
      const unlisted = `Unable to list Docker containers while looking for stack ${id}'s leftovers: permission denied`;
      const api = Layer.succeed(StackApi, {
        ...f.api,
        findDeleted: () => Effect.fail(new StackError({ operation: "find", message: unlisted })),
      });

      const error = yield* stackDestroy({ ...f.flags, stackId: Option.some(id) }).pipe(
        Effect.provide(Layer.merge(f.layer, api)),
        Effect.flip,
      );

      expect(error.reason).toBe("flags");
      expect(error.message).toContain("was not found");
      expect(error.suggestion).toContain("Run `supabase stack list`");
      expect(error.detail).toBe(unlisted);
    }).pipe(Effect.provide(live)),
  );

  it.live(
    "destroys a live namespace and standalone services while preserving caller-owned uploads",
    () =>
      Effect.gen(function* () {
        const f = yield* fixture(true);
        const uploads = f.path.join(f.root, "uploads");
        yield* f.fs.makeDirectory(uploads);
        yield* f.fs.writeFileString(f.path.join(uploads, "object.txt"), "keep this upload");
        yield* Effect.acquireUseRelease(
          f.stack.services.create({
            service: "storage",
            config: {
              jwtSecret: "test-secret",
              filePath: uploads,
            },
            endpoints: {},
          }),
          () =>
            Effect.gen(function* () {
              yield* f.stack.services.create({ service: "mail", config: {}, endpoints: {} });
              yield* stackDestroy(f.flags).pipe(Effect.provide(f.layer));
              expect(yield* f.api.discover(f.locations)).toEqual([]);
              expect(yield* f.fs.readFileString(f.path.join(uploads, "object.txt"))).toBe(
                "keep this upload",
              );
            }),
          () =>
            f.api
              .discover(f.locations)
              .pipe(
                Effect.flatMap((entries) =>
                  entries.some(({ host }) => host !== undefined) ? f.stack.stop : Effect.void,
                ),
              ),
        );
      }).pipe(Effect.provide(live)),
  );

  it.live("destroys multiple stacks when repeated --stack-id flags are provided", () =>
    Effect.gen(function* () {
      const f = yield* fixture(true);
      const second = yield* f.api.create({
        ...f.locations,
        projectRoot: f.root,
        name: "second",
        runtime: "native",
      });
      const third = yield* f.api.create({
        ...f.locations,
        projectRoot: f.root,
        name: "third",
        runtime: "native",
      });

      yield* stackDestroy({
        ...f.flags,
        stackId: [f.stack.id, second.id],
      }).pipe(Effect.provide(f.layer));

      const remaining = yield* f.api.discover(f.locations);
      expect(remaining.map(({ definition }) => definition.id)).toEqual([third.id]);
      expect(f.output.stderrText).toContain(
        `Permanently destroying stacks ${f.stack.id}, ${second.id} and their owned data. Storage upload files will be preserved.\n`,
      );
      expect(f.output.stdoutText).toContain(`Stack ${f.stack.id} destroyed.`);
      expect(f.output.stdoutText).toContain(`Stack ${second.id} destroyed.`);
      expect(f.telemetry.flushed).toBe(true);
    }).pipe(Effect.provide(live)),
  );

  it.live(
    "prompts once for multiple stacks on an interactive terminal and cancels all when declined",
    () =>
      Effect.gen(function* () {
        const f = yield* fixture(false, { answer: false });
        const second = yield* f.api.create({
          ...f.locations,
          projectRoot: f.root,
          name: "second",
          runtime: "native",
        });

        const error = yield* stackDestroy({
          ...f.flags,
          stackId: [f.stack.id, second.id],
        }).pipe(Effect.provide(f.layer), Effect.flip);

        expect(error.reason).toBe("cancelled");
        expect(f.output.promptConfirmCalls.map(({ message }) => message)).toEqual([
          `Permanently destroy stacks ${f.stack.id}, ${second.id} and their owned data? Storage upload files will be preserved.`,
        ]);
        const saved = yield* f.api.discover(f.locations);
        expect(saved.map(({ definition }) => definition.id).sort()).toEqual(
          [f.stack.id, second.id].sort(),
        );
      }).pipe(Effect.provide(live)),
  );

  it.live("rejects combining --stack and multiple --stack-id", () =>
    Effect.gen(function* () {
      const f = yield* fixture(true);
      const second = yield* f.api.create({
        ...f.locations,
        projectRoot: f.root,
        name: "second",
        runtime: "native",
      });

      const error = yield* stackDestroy({
        stack: Option.some("custom-stack"),
        stackId: [f.stack.id, second.id],
      }).pipe(Effect.provide(f.layer), Effect.flip);

      expect(error.reason).toBe("flags");
      expect(error.message).toBe("--stack and --stack-id cannot be used together");
    }).pipe(Effect.provide(live)),
  );

  it.live("continues destroying remaining stacks when one fails and exits with error", () =>
    Effect.gen(function* () {
      const f = yield* fixture(true);
      const second = yield* f.api.create({
        ...f.locations,
        projectRoot: f.root,
        name: "second",
        runtime: "native",
      });

      const failingApi = StackApi.of({
        ...f.api,
        open: (opts) =>
          f.api.open(opts).pipe(
            Effect.map((s) =>
              s.id === f.stack.id
                ? {
                    ...s,
                    destroy: Effect.fail(
                      new StackError({
                        operation: "destroy",
                        message: "simulated destruction failure",
                      }),
                    ),
                  }
                : s,
            ),
          ),
      });

      const error = yield* stackDestroy({
        ...f.flags,
        stackId: [f.stack.id, second.id],
      }).pipe(
        Effect.provide(Layer.merge(f.layer, Layer.succeed(StackApi, failingApi))),
        Effect.flip,
      );

      expect(error.reason).toBe("unknown");
      expect(error.message).toContain("Failed to destroy 1 managed stack(s).");
      expect(error.detail).toContain(`${f.stack.id}: simulated destruction failure`);

      const remaining = yield* f.api.discover(f.locations);
      expect(remaining.map(({ definition }) => definition.id)).toEqual([f.stack.id]);
      expect(f.output.stdoutText).toContain(`Stack ${second.id} destroyed.`);
    }).pipe(Effect.provide(live)),
  );
});
