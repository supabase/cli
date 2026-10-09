import { BunServices } from "@effect/platform-bun";
import { describe, expect, it } from "@effect/vitest";
import { StackError } from "@supabase/stack/effect";
import { Effect, FileSystem, Layer, Option, Path, Schema, Sink, Stdio, Stream } from "effect";
import { CliOutput, Command } from "effect/unstable/cli";
import { CliArgs } from "../../../../shared/cli/cli-args.service.ts";
import { jsonOutputLayer } from "../../../../shared/output/output.layer.ts";
import { textCliOutputFormatter } from "../../../../shared/output/text-formatter.ts";
import { commandRuntimeLayer } from "../../../../shared/runtime/command-runtime.layer.ts";
import { YesFlag } from "../../../../command-internal/global-flags.ts";
import {
  mockCommandSettings,
  mockTelemetryStateTracked,
} from "../../../../../tests/helpers/command-mocks.ts";
import {
  mockAnalytics,
  mockOutput,
  mockProcessControl,
  mockStdin,
  mockTty,
} from "../../../../../tests/helpers/mocks.ts";
import { StackApi, stackApiLayer, stackTargetResolverLayer } from "../stack.shared.ts";
import { stackDestroyCommand } from "./destroy.command.ts";
import { stackDestroy } from "./destroy.handler.ts";

const live = Layer.provideMerge(stackApiLayer, BunServices.layer);
const refuseDestroy = (
  api: StackApi["Service"],
  ids: ReadonlyArray<string>,
  unreachable: ReadonlyArray<string> = [],
) =>
  Layer.succeed(StackApi, {
    ...api,
    open: (options) =>
      api.open(options).pipe(
        Effect.map((stack) => {
          const reason = unreachable.includes(stack.id) ? "runtime-unavailable" : undefined;
          return ids.includes(stack.id)
            ? {
                ...stack,
                destroy: Effect.fail(
                  new StackError({
                    operation: "destroy",
                    message: "engine refused",
                    ...(reason === undefined ? {} : { reason }),
                  }),
                ),
              }
            : stack;
        }),
      ),
  });
const runDestroy = <A, E, R>(layer: Layer.Layer<A, E, R>, argv: ReadonlyArray<string>) =>
  Command.runWith(stackDestroyCommand.pipe(Command.provide(layer)), { version: "0.0.0-test" })(
    argv,
  ).pipe(
    Effect.provide(
      Layer.mergeAll(
        CliOutput.layer(textCliOutputFormatter()),
        mockAnalytics().layer,
        mockProcessControl().layer,
        commandRuntimeLayer(["stack", "destroy"]),
      ),
    ),
  );
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
    flags: { stack: Option.none<string>(), stackId: [stack.id] },
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

  it.live("refuses a stack with an unknown service kind and names its directory", () =>
    Effect.gen(function* () {
      const f = yield* fixture(true);
      const statePath = f.path.join(f.locations.stateRoot, f.stack.id, "state.json");
      const saved = yield* f.fs.readFileString(statePath);
      yield* f.fs.writeFileString(
        statePath,
        saved.replace('"instances":[]', '"instances":[{"id":"logs","service":"vector"}]'),
      );

      const error = yield* stackDestroy(f.flags).pipe(Effect.provide(f.layer), Effect.flip);

      expect(error.message).toContain(
        `Remove its directory ${f.path.join(f.locations.stateRoot, f.stack.id)}`,
      );
      expect(yield* f.fs.exists(statePath)).toBe(true);
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

      yield* stackDestroy({ ...f.flags, stackId: [f.stack.id.slice(0, 8)] }).pipe(
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
                  }),
                })
              : Option.none(),
          ),
      });

      yield* stackDestroy({ ...f.flags, stackId: [id] }).pipe(
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

      const error = yield* stackDestroy({ ...f.flags, stackId: [id] }).pipe(
        Effect.provide(Layer.merge(f.layer, api)),
        Effect.flip,
      );

      expect(error.reason).toBe("flags");
      expect(error.message).toContain("was not found");
      expect(error.suggestion).toContain("Run `supabase stack list`");
      expect(error.detail).toBe(unlisted);

      const ids = [id, "e".repeat(64)];
      const batch = yield* stackDestroy({ ...f.flags, stackId: ids }).pipe(
        Effect.provide(Layer.merge(f.layer, api)),
        Effect.flip,
      );

      expect(batch.detail).toBe(
        ids
          .map((stackId) => `${stackId}: Stack ${stackId} was not found\n  ${unlisted}`)
          .join("\n"),
      );
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

  it.live("destroys each stack named by repeated --stack-id flags once", () =>
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
      const output = mockOutput({ format: "json" });

      yield* runDestroy(Layer.merge(f.layer, output.layer), [
        "--stack-id",
        f.stack.id,
        "--stack-id",
        second.id.slice(0, 8),
        "--stack-id",
        f.stack.id.slice(0, 8),
      ]);

      expect((yield* f.api.discover(f.locations)).map(({ definition }) => definition.id)).toEqual([
        third.id,
      ]);
      expect(output.stderrText).toBe(
        `Permanently destroying stack ${f.stack.id} at ${f.projectRoot} and its owned data; stack ${second.id} at ${f.projectRoot} and its owned data. Storage upload files will be preserved.\n`,
      );
      expect(output.messages).toContainEqual(
        expect.objectContaining({
          type: "success",
          data: {
            destroyed: true,
            stacks: [{ id: f.stack.id }, { id: second.id }],
          },
        }),
      );
    }).pipe(Effect.provide(live)),
  );

  it.live("keeps the batch result when repeated --stack-id flags name one stack", () =>
    Effect.gen(function* () {
      const f = yield* fixture(true);
      const output = mockOutput({ format: "json" });

      yield* runDestroy(Layer.merge(f.layer, output.layer), [
        "--stack-id",
        f.stack.id,
        "--stack-id",
        f.stack.id.slice(0, 8),
      ]);

      expect(output.messages).toContainEqual(
        expect.objectContaining({
          type: "success",
          data: { destroyed: true, stacks: [{ id: f.stack.id }] },
        }),
      );
    }).pipe(Effect.provide(live)),
  );

  it.live("rejects --stack combined with repeated --stack-id flags", () =>
    Effect.gen(function* () {
      const f = yield* fixture(true);

      const error = yield* runDestroy(f.layer, [
        "--stack",
        "other",
        "--stack-id",
        f.stack.id,
        "--stack-id",
        f.stack.id.slice(0, 8),
      ]).pipe(Effect.flip);

      expect(error).toMatchObject({
        reason: "flags",
        message: "--stack and --stack-id cannot be used together",
      });
      expect((yield* f.api.discover(f.locations)).map(({ definition }) => definition.id)).toEqual([
        f.stack.id,
      ]);
    }).pipe(Effect.provide(live)),
  );

  it.live("asks once for every selected stack and keeps them all when declined", () =>
    Effect.gen(function* () {
      const f = yield* fixture(false, { answer: false });
      const second = yield* f.api.create({
        ...f.locations,
        projectRoot: f.root,
        name: "second",
        runtime: "native",
      });

      const error = yield* stackDestroy({ ...f.flags, stackId: [f.stack.id, second.id] }).pipe(
        Effect.provide(f.layer),
        Effect.flip,
      );

      expect(error.reason).toBe("cancelled");
      expect(f.output.promptConfirmCalls.map(({ message }) => message)).toEqual([
        `Permanently destroy stack ${f.stack.id} at ${f.projectRoot} and its owned data; stack ${second.id} at ${f.projectRoot} and its owned data? Storage upload files will be preserved.`,
      ]);
      expect(
        (yield* f.api.discover(f.locations)).map(({ definition }) => definition.id).toSorted(),
      ).toEqual([f.stack.id, second.id].toSorted());
    }).pipe(Effect.provide(live)),
  );

  it.live("destroys nothing and names every later --stack-id that is not found", () =>
    Effect.gen(function* () {
      const f = yield* fixture(true);
      const missing = ["0000", "1111", "2222"]
        .filter((prefix) => !f.stack.id.startsWith(prefix))
        .slice(0, 2);

      const error = yield* runDestroy(f.layer, [
        "--stack-id",
        f.stack.id,
        ...missing.flatMap((id) => ["--stack-id", id]),
      ]).pipe(Effect.flip);

      expect(error).toMatchObject({
        reason: "flags",
        message: "Failed to resolve 2 --stack-id values.",
        detail: missing.map((id) => `${id}: Stack ${id} was not found`).join("\n"),
      });
      expect(f.output.stderrText).toBe("");
      expect((yield* f.api.discover(f.locations)).map(({ definition }) => definition.id)).toEqual([
        f.stack.id,
      ]);
    }).pipe(Effect.provide(live)),
  );

  it.live("fails a single stack with its own destroy error", () =>
    Effect.gen(function* () {
      const f = yield* fixture(true);

      const error = yield* stackDestroy(f.flags).pipe(
        Effect.provide(Layer.merge(f.layer, refuseDestroy(f.api, [f.stack.id]))),
        Effect.flip,
      );

      expect(error).toMatchObject({ reason: "stack", message: "engine refused" });
      expect((yield* f.api.discover(f.locations)).map(({ definition }) => definition.id)).toEqual([
        f.stack.id,
      ]);
    }).pipe(Effect.provide(live)),
  );

  it.live("points a batch at the engine only when it was unreachable for every stack", () =>
    Effect.gen(function* () {
      const f = yield* fixture(true);
      const second = yield* f.api.create({
        ...f.locations,
        projectRoot: f.root,
        name: "second",
        runtime: "native",
      });
      const ids = [f.stack.id, second.id];
      const retry = `"supabase stack destroy --stack-id ${f.stack.id} --stack-id ${second.id} --yes"`;
      const destroyWith = (unreachable: ReadonlyArray<string>) =>
        stackDestroy({ ...f.flags, stackId: ids }).pipe(
          Effect.provide(Layer.merge(f.layer, refuseDestroy(f.api, ids, unreachable))),
          Effect.flip,
        );

      expect(yield* destroyWith([f.stack.id])).toMatchObject({
        reason: "stack",
        suggestion: `Resolve each error, then run ${retry} to retry the stacks that failed.`,
      });
      expect(yield* destroyWith(ids)).toMatchObject({
        reason: "runtime",
        suggestion: `Start the container engine, then run ${retry} again; nothing was removed for those stacks.`,
      });
      expect(
        (yield* f.api.discover(f.locations)).map(({ definition }) => definition.id).toSorted(),
      ).toEqual(ids.toSorted());
    }).pipe(Effect.provide(live)),
  );

  it.live("destroys a registered stack and a deleted stack's containers in one batch", () =>
    Effect.gen(function* () {
      const f = yield* fixture(true);
      const id = "d".repeat(64);
      let removed = 0;
      const api = Layer.succeed(StackApi, {
        ...f.api,
        findDeleted: (options) =>
          Effect.succeed(
            options.id === id
              ? Option.some({
                  id,
                  destroy: Effect.sync(() => {
                    removed += 1;
                  }),
                })
              : Option.none(),
          ),
      });

      yield* stackDestroy({ ...f.flags, stackId: [f.stack.id, id] }).pipe(
        Effect.provide(Layer.merge(f.layer, api)),
      );

      expect(removed).toBe(1);
      expect(f.output.stderrText).toBe(
        `Permanently destroying stack ${f.stack.id} at ${f.projectRoot} and its owned data; the containers deleted stack ${id} left behind. Storage upload files will be preserved.\n`,
      );
      expect(f.output.stdoutText).toBe(
        `Stack ${f.stack.id} destroyed.\nRemoved the containers stack ${id} left behind.\n`,
      );
      expect(yield* f.api.discover(f.locations)).toEqual([]);
    }).pipe(Effect.provide(live)),
  );

  it.live("keeps destroying after a failure and fails once with the stacks it destroyed", () =>
    Effect.gen(function* () {
      const f = yield* fixture(true);
      const second = yield* f.api.create({
        ...f.locations,
        projectRoot: f.root,
        name: "second",
        runtime: "native",
      });
      const stdout: Array<string> = [];
      const stdio = Layer.succeed(
        Stdio.Stdio,
        Stdio.make({
          args: Effect.succeed([]),
          stdin: Stream.empty,
          stdout: () =>
            Sink.forEach((item: string | Uint8Array) =>
              Effect.sync(() => {
                stdout.push(typeof item === "string" ? item : new TextDecoder().decode(item));
              }),
            ),
          stderr: () => Sink.forEach(() => Effect.void),
        }),
      );
      const processControl = mockProcessControl();

      yield* runDestroy(
        Layer.merge(
          f.layer,
          Layer.mergeAll(
            refuseDestroy(f.api, [f.stack.id]),
            jsonOutputLayer.pipe(Layer.provide(stdio)),
            processControl.layer,
          ),
        ),
        ["--stack-id", f.stack.id, "--stack-id", second.id],
      );

      expect((yield* f.api.discover(f.locations)).map(({ definition }) => definition.id)).toEqual([
        f.stack.id,
      ]);
      expect(
        yield* Schema.decodeEffect(Schema.fromJsonString(Schema.Unknown))(stdout.join("")),
      ).toEqual({
        destroyed_stacks: [{ id: second.id }],
        _tag: "Error",
        error: {
          code: "ExperimentalStackDestroyError",
          message: "Failed to destroy 1 managed stack(s).",
          detail: `${f.stack.id}: engine refused`,
          suggestion: `Resolve each error, then run "supabase stack destroy --stack-id ${f.stack.id} --yes" to retry the stacks that failed.`,
        },
      });
      expect(processControl.exitCode).toBe(1);
    }).pipe(Effect.provide(live)),
  );
});
