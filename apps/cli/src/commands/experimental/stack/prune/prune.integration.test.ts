import { BunCrypto, BunServices } from "@effect/platform-bun";
import { describe, expect, it } from "@effect/vitest";
import { StackError } from "@supabase/stack/effect";
import { Effect, FileSystem, Layer, Option, Path, PlatformError } from "effect";
import { CliOutput, Command } from "effect/cli";
import { CliArgs } from "../../../../shared/cli/cli-args.service.ts";
import { textCliOutputFormatter } from "../../../../shared/output/text-formatter.ts";
import { commandRuntimeLayer } from "../../../../shared/runtime/command-runtime.layer.ts";
import { OutputFlag, YesFlag } from "../../../../command-internal/global-flags.ts";
import { stackUploadsDir } from "../../../../command-internal/stack-config.ts";
import { StackApi, stackApiLayer } from "../../../../command-internal/stack-target.ts";
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
import { stackPruneCommand } from "./prune.command.ts";
import { StackCommandPruneError } from "./prune.errors.ts";
import { stackPrune } from "./prune.handler.ts";

const live = Layer.provideMerge(stackApiLayer, Layer.merge(BunServices.layer, BunCrypto.layer));

const fixture = Effect.fn("StackPruneTest.fixture")(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const api = yield* StackApi;
  const home = yield* fs
    .makeTempDirectoryScoped({ prefix: "stack-prune-" })
    .pipe(Effect.flatMap(fs.realPath));
  const locations = { stateRoot: path.join(home, "stacks"), cacheRoot: path.join(home, "cache") };
  const repo = path.join(home, "repo");
  const gitDir = path.join(repo, ".git");
  for (const dir of ["objects", "refs", path.join("worktrees", "feature")])
    yield* fs.makeDirectory(path.join(gitDir, dir), { recursive: true });
  yield* fs.writeFileString(path.join(gitDir, "HEAD"), "ref: refs/heads/main\n");
  const worktree = path.join(home, "feature");
  yield* fs.makeDirectory(worktree);
  yield* fs.writeFileString(
    path.join(worktree, ".git"),
    `gitdir: ${path.join(gitDir, "worktrees", "feature")}\n`,
  );
  yield* fs.writeFileString(
    path.join(gitDir, "worktrees", "feature", "HEAD"),
    "ref: refs/heads/feature\n",
  );
  const app = path.join(home, "app");
  yield* fs.makeDirectory(app);

  const create = (projectRoot: string) =>
    api.create({ ...locations, projectRoot, runtime: "native" });
  const kept = yield* create(repo);
  const deletedWorktree = yield* create(worktree);
  const moved = yield* create(app);
  yield* fs.remove(worktree, { recursive: true });
  yield* fs.rename(app, path.join(home, "app-moved"));

  const uploads = stackUploadsDir(path, home, moved.id);
  yield* fs.makeDirectory(uploads, { recursive: true });
  yield* fs.writeFileString(path.join(uploads, "object.txt"), "upload");

  const telemetry = mockTelemetryStateTracked();
  const settings = mockCommandSettings({ workdir: repo, supabaseHome: home });
  const layer = (options: {
    readonly yes: boolean;
    readonly output: ReturnType<typeof mockOutput>;
    readonly tty?: boolean;
    readonly home?: string;
  }) =>
    Layer.mergeAll(
      options.output.layer,
      telemetry.layer,
      options.home === undefined
        ? settings
        : mockCommandSettings({ workdir: options.home, supabaseHome: options.home }),
      mockTty({ stdinIsTty: options.tty ?? false }),
      mockStdin(false),
      Layer.succeed(YesFlag, options.yes),
      Layer.succeed(CliArgs, { args: options.yes ? ["--yes"] : ["--yes=false"] }),
    );
  const savedIds = api
    .discover(locations)
    .pipe(Effect.map((entries) => entries.map(({ definition }) => definition.id).sort()));
  return {
    fs,
    path,
    home,
    worktree,
    create,
    kept,
    deletedWorktree,
    moved,
    uploads,
    telemetry,
    layer,
    savedIds,
    allIds: [kept.id, deletedWorktree.id, moved.id].sort(),
    orphanIds: [deletedWorktree.id, moved.id].sort(),
  };
});

const runPrune = <A, E, R>(layer: Layer.Layer<A, E, R>, argv: ReadonlyArray<string>) =>
  Command.runWith(stackPruneCommand.pipe(Command.provide(layer)), { version: "0.0.0-test" })(
    argv,
  ).pipe(
    Effect.provide(
      Layer.mergeAll(
        CliOutput.layer(textCliOutputFormatter()),
        mockAnalytics().layer,
        mockProcessControl().layer,
        commandRuntimeLayer(["stack", "prune"]),
      ),
    ),
  );

describe("stack prune", () => {
  it.live(
    "lists the stacks of a deleted worktree and a moved directory, then destroys only those",
    () =>
      Effect.gen(function* () {
        const f = yield* fixture();
        const invalid = f.path.join(f.home, "stacks", "invalid");
        yield* f.fs.makeDirectory(invalid);
        yield* f.fs.writeFileString(f.path.join(invalid, "state.json"), "{broken");

        const preview = mockOutput({ format: "text", interactive: false });
        yield* runPrune(f.layer({ yes: false, output: preview }), ["--dry-run"]);
        expect(preview.stdoutText).toContain(
          "Found 2 stacks whose project directory no longer exists:",
        );
        expect(preview.stdoutText).toContain("refs/heads/feature");
        expect(preview.stdoutText).toContain("ordinary-workspace");
        expect(preview.stdoutText).not.toContain("refs/heads/main");
        expect(preview.stderrText).toContain("Warning: skipping invalid stack invalid");
        expect(yield* f.savedIds).toEqual(f.allIds);

        const machine = mockOutput({ format: "json" });
        const listed = yield* stackPrune({ dryRun: true }).pipe(
          Effect.provide(f.layer({ yes: false, output: machine })),
        );
        expect(listed.map(({ id }) => id).sort()).toEqual(f.orphanIds);
        expect(machine.messages).toContainEqual(
          expect.objectContaining({ data: { dry_run: true, stacks: listed } }),
        );
        expect(yield* f.savedIds).toEqual(f.allIds);

        const removal = mockOutput({ format: "json" });
        const pruned = yield* stackPrune({ dryRun: false }).pipe(
          Effect.provide(f.layer({ yes: true, output: removal })),
        );
        expect(pruned).toEqual(listed);
        expect(removal.messages).toContainEqual(
          expect.objectContaining({ data: { dry_run: false, stacks: pruned } }),
        );
        expect(yield* f.savedIds).toEqual([f.kept.id]);
        expect(yield* f.fs.exists(f.uploads)).toBe(false);
        expect(f.telemetry.flushCount).toBe(3);
      }).pipe(Effect.provide(live)),
    { timeout: 60_000 },
  );

  it.live(
    "destroys nothing without confirmation and reports when no project directory is missing",
    () =>
      Effect.gen(function* () {
        const f = yield* fixture();

        const unattended = yield* stackPrune({ dryRun: false }).pipe(
          Effect.provide(f.layer({ yes: false, output: mockOutput({ interactive: false }) })),
          Effect.flip,
        );
        expect(unattended.reason).toBe("confirmation");

        const declined = mockOutput({ interactive: true, promptConfirmResponses: [false] });
        const cancelled = yield* stackPrune({ dryRun: false }).pipe(
          Effect.provide(f.layer({ yes: false, output: declined, tty: true })),
          Effect.flip,
        );
        expect(cancelled.reason).toBe("cancelled");
        expect(declined.promptConfirmCalls).toHaveLength(1);

        const legacyOutput = yield* stackPrune({ dryRun: false }).pipe(
          Effect.provide(
            Layer.mergeAll(
              f.layer({ yes: true, output: mockOutput() }),
              Layer.succeed(OutputFlag, Option.some("json")),
            ),
          ),
          Effect.flip,
        );
        expect(legacyOutput.reason).toBe("flags");
        expect(yield* f.savedIds).toEqual(f.allIds);

        const emptyHome = yield* f.fs.makeTempDirectoryScoped({ prefix: "stack-prune-empty-" });
        const empty = mockOutput();
        const none = yield* stackPrune({ dryRun: false }).pipe(
          Effect.provide(f.layer({ yes: false, output: empty, home: emptyHome })),
        );
        expect(none).toEqual([]);
        expect(empty.stdoutText).toBe(
          "No stacks found whose project directory no longer exists.\n",
        );
        expect(empty.promptConfirmCalls).toEqual([]);
      }).pipe(Effect.provide(live)),
    { timeout: 60_000 },
  );

  it.live(
    "names a single stack that fails to be destroyed, with a retry command",
    () =>
      Effect.gen(function* () {
        const f = yield* fixture();
        const api = yield* StackApi;
        const refuse = Layer.succeed(StackApi, {
          ...api,
          open: (options) =>
            api.open(options).pipe(
              Effect.map((stack) =>
                stack.id === f.moved.id
                  ? {
                      ...stack,
                      destroy: Effect.fail(
                        new StackError({ operation: "destroy", message: "engine refused" }),
                      ),
                    }
                  : stack,
              ),
            ),
        });

        /* Recreating the worktree directory leaves the moved directory as the only match. */
        yield* f.fs.makeDirectory(f.worktree);
        const output = mockOutput({ format: "json" });
        const error = yield* stackPrune({ dryRun: false }).pipe(
          Effect.provide(Layer.mergeAll(f.layer({ yes: true, output }), refuse)),
          Effect.flip,
        );

        expect(error).toBeInstanceOf(StackCommandPruneError);
        expect(error.message).toBe("Failed to destroy 1 managed stack(s).");
        expect(error.detail).toBe(`${f.moved.id}: engine refused`);
        expect(error.suggestion).toContain('"supabase stack prune --yes"');
        expect(error.suggestion).not.toContain("--stack-id");
        expect(output.messages.filter(({ type }) => type === "success")).toEqual([]);
        expect(yield* f.savedIds).toEqual(f.allIds);
      }).pipe(Effect.provide(live)),
    { timeout: 60_000 },
  );

  it.live(
    "keeps a stack whose project directory cannot be checked and destroys after a yes on a terminal",
    () =>
      Effect.gen(function* () {
        const f = yield* fixture();
        const locked = f.path.join(f.home, "locked");
        yield* f.fs.makeDirectory(locked);
        const unchecked = yield* f.create(locked);

        const confirmed = mockOutput({ interactive: true, promptConfirmResponses: [true] });
        const pruned = yield* stackPrune({ dryRun: false }).pipe(
          Effect.provide(f.layer({ yes: false, output: confirmed, tty: true })),
          Effect.provideService(FileSystem.FileSystem, {
            ...f.fs,
            exists: (target) =>
              target === locked
                ? Effect.fail(
                    PlatformError.systemError({
                      _tag: "PermissionDenied",
                      module: "FileSystem",
                      method: "exists",
                      description: "denied",
                      pathOrDescriptor: target,
                    }),
                  )
                : f.fs.exists(target),
          }),
        );

        expect(pruned.map(({ id }) => id).sort()).toEqual(f.orphanIds);
        expect(confirmed.promptConfirmCalls.map(({ message }) => message)).toEqual([
          "Permanently destroy the 2 stacks listed above and their owned data?",
        ]);
        expect(confirmed.stderrText).toContain(
          `Warning: keeping stack ${unchecked.id}; its project directory could not be checked`,
        );
        expect(yield* f.savedIds).toEqual([f.kept.id, unchecked.id].sort());
      }).pipe(Effect.provide(live)),
    { timeout: 60_000 },
  );

  it.live(
    "keeps a stack whose project directory comes back before it is destroyed",
    () =>
      Effect.gen(function* () {
        const f = yield* fixture();
        let checks = 0;
        const output = mockOutput({ format: "json" });
        const pruned = yield* stackPrune({ dryRun: false }).pipe(
          Effect.provide(f.layer({ yes: true, output })),
          Effect.provideService(FileSystem.FileSystem, {
            ...f.fs,
            exists: (target) =>
              target === f.worktree
                ? Effect.sync(() => {
                    checks += 1;
                    return checks > 1;
                  })
                : f.fs.exists(target),
          }),
        );

        expect(pruned.map(({ id }) => id)).toEqual([f.moved.id]);
        expect(output.stderrText).toContain(
          `Warning: keeping stack ${f.deletedWorktree.id}; its project directory exists again.`,
        );
        expect(output.messages).toContainEqual(
          expect.objectContaining({ data: { dry_run: false, stacks: pruned } }),
        );
        expect(yield* f.savedIds).toEqual([f.kept.id, f.deletedWorktree.id].sort());
      }).pipe(Effect.provide(live)),
    { timeout: 60_000 },
  );

  it.live(
    "counts stacks that another process destroyed meanwhile as destroyed",
    () =>
      Effect.gen(function* () {
        const f = yield* fixture();
        const api = yield* StackApi;
        const locations = {
          stateRoot: f.path.join(f.home, "stacks"),
          cacheRoot: f.path.join(f.home, "cache", "stack"),
        };
        const destroyElsewhere = (id: string) =>
          Effect.scoped(
            api.open({ ...locations, id }).pipe(Effect.flatMap((stack) => stack.destroy)),
          );
        const lost = new StackError({ operation: "destroy", message: "Stack is not registered" });
        /* The worktree's stack is gone before it is opened, the moved one while it is destroyed. */
        const racing = Layer.succeed(StackApi, {
          ...api,
          open: (options) =>
            options.id === f.deletedWorktree.id
              ? destroyElsewhere(options.id).pipe(Effect.andThen(Effect.fail(lost)))
              : api.open(options).pipe(
                  Effect.map((stack) =>
                    stack.id === f.moved.id
                      ? {
                          ...stack,
                          destroy: stack.destroy.pipe(Effect.andThen(Effect.fail(lost))),
                        }
                      : stack,
                  ),
                ),
        });

        const output = mockOutput({ format: "json" });
        const pruned = yield* stackPrune({ dryRun: false }).pipe(
          Effect.provide(Layer.mergeAll(f.layer({ yes: true, output }), racing)),
        );

        expect(pruned.map(({ id }) => id).sort()).toEqual(f.orphanIds);
        expect(yield* f.savedIds).toEqual([f.kept.id]);
        expect(yield* f.fs.exists(f.uploads)).toBe(false);
      }).pipe(Effect.provide(live)),
    { timeout: 60_000 },
  );
});
