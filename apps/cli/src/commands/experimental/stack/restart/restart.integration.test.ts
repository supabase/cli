// oxlint-disable-next-line effecttsgo/node-builtin-import -- filesystem test fixture uses the host adapter
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
// oxlint-disable-next-line effecttsgo/node-builtin-import -- filesystem test fixture uses the host adapter
import { join } from "node:path";
import { BunServices } from "@effect/platform-bun";
import { describe, expect, it } from "@effect/vitest";
import { Effect, Layer, Option, Stream } from "effect";
import {
  StackIdSchema,
  StackPreparationError,
  StackStateInvalidError,
  type EffectStack,
  type StackStatus,
} from "@supabase/stack/effect";
import { mockOutput } from "../../../../../tests/helpers/mocks.ts";
import {
  mockCommandSettings,
  mockTelemetryStateTracked,
} from "../../../../../tests/helpers/command-mocks.ts";
import { StackApi } from "../stack.shared.ts";
import { stackRestart } from "./restart.handler.ts";

const id = StackIdSchema.make("a".repeat(64));
const project = (projectId = "restart-test") => {
  const root = mkdtempSync(join(tmpdir(), "supabase-stack-restart-"));
  mkdirSync(join(root, "supabase"), { recursive: true });
  writeFileSync(
    join(root, "supabase", "config.toml"),
    `[api]\nmax_rows = ${projectId === "id-project" ? 2345 : 1234}\n`,
  );
  return root;
};
const status = (): StackStatus => ({
  id,
  lifecycle: "running",
  desiredLifecycle: "running",
  runtime: { kind: "native" },
  endpoints: {},
  versions: {},
  capabilities: [],
  artifacts: [],
});

const flags = (overrides: Partial<Parameters<typeof stackRestart>[0]> = {}) => ({
  stack: Option.none<string>(),
  stackId: Option.none<string>(),
  ...overrides,
});

const fixture = (options: {
  prepare?: "ok" | "fail";
  stop?: "ok" | "fail";
  start?: "ok" | "fail";
  idProject?: boolean;
  format?: "text" | "json";
  config?: "valid" | "invalid";
  found?: boolean;
}) => {
  const root = project();
  if (options.config === "invalid")
    writeFileSync(join(root, "supabase", "config.toml"), 'project_id = "unterminated\n');
  const idRoot = options.idProject === true ? project("id-project") : root;
  const calls: string[] = [];
  let lifecycle: StackStatus["lifecycle"] = "running";
  let preparedConfig: unknown;
  let startedConfig: unknown;
  let selectedName: string | undefined;
  const output = mockOutput({ format: options.format });
  const telemetry = mockTelemetryStateTracked();
  const stack: EffectStack = {
    id,
    status: Effect.sync(() => ({ ...status(), lifecycle })),
    credentials: Effect.die("unused"),
    prepare: (input) =>
      Effect.sync(() => {
        calls.push("prepare");
        preparedConfig = input?.config;
      }).pipe(
        Effect.flatMap(() =>
          options.prepare === "fail"
            ? Effect.fail(new StackPreparationError({ message: "prepare failed" }))
            : Effect.succeed({ capabilities: [] }),
        ),
      ),
    stop: Effect.gen(function* () {
      calls.push("stop");
      if (options.stop === "fail")
        return yield* new StackStateInvalidError({ message: "stop failed" });
      lifecycle = "stopped";
    }),
    start: (input) =>
      Effect.sync(() => calls.push("start")).pipe(
        Effect.tap(() =>
          Effect.sync(() => {
            startedConfig = input?.config;
          }),
        ),
        Effect.flatMap(() =>
          options.start === "fail"
            ? Effect.fail(new StackPreparationError({ message: "start failed" }))
            : Effect.sync(() => {
                lifecycle = "running";
                return status();
              }),
        ),
      ),
    destroy: Effect.die("unused"),
    logs: () => Effect.die("unused"),
    followLogs: () => Stream.empty,
  };
  const layer = Layer.mergeAll(
    output.layer,
    telemetry.layer,
    mockCommandSettings({ workdir: root }),
    Layer.succeed(StackApi, {
      findStack: ({ projectRoot, name }) =>
        Effect.sync(() => {
          selectedName = name;
          return options.found === false || projectRoot !== root
            ? Option.none()
            : Option.some({
                id,
                projectRoot: root,
                name: name ?? "restart-test",
                branchContext: "default",
                runtime: { kind: "native" as const },
                desiredLifecycle: "running" as const,
              });
        }),
      createStack: () => Effect.die("create must not run"),
      openStack: () => Effect.succeed(stack),
      inspectStack: () =>
        options.idProject === true
          ? Effect.succeed({
              descriptor: {
                id,
                projectRoot: idRoot,
                name: "id-project",
                branchContext: "default",
                runtime: { kind: "native" as const },
                desiredLifecycle: "running" as const,
              },
              owner: "running" as const,
            })
          : Effect.die("inspect unused"),
      discoverStacks: () => Effect.succeed({ stacks: [], errors: [] }),
    }),
    BunServices.layer,
  );
  return {
    root,
    idRoot,
    calls,
    output,
    telemetry,
    layer,
    get preparedConfig() {
      return preparedConfig;
    },
    get lifecycle() {
      return lifecycle;
    },
    get startedConfig() {
      return startedConfig;
    },
    get selectedName() {
      return selectedName;
    },
    cleanup: () => {
      rmSync(root, { recursive: true, force: true });
      if (idRoot !== root) rmSync(idRoot, { recursive: true, force: true });
    },
  };
};

describe("stack restart", () => {
  it.live("prepares before stopping and starts the same stack", () => {
    const setup = fixture({});
    return stackRestart(flags()).pipe(
      Effect.provide(setup.layer),
      Effect.tap(() =>
        Effect.sync(() => {
          expect(setup.calls).toEqual(["prepare", "stop", "start"]);
          expect(setup.preparedConfig).toMatchObject({
            capabilities: { rest: { settings: { max_rows: 1234 } } },
          });
          expect(setup.lifecycle).toBe("running");
          expect(setup.startedConfig).toBe(setup.preparedConfig);
          expect(setup.telemetry.flushed).toBe(true);
          expect(setup.output.stdoutText).toContain(`Stack ${id}`);
        }),
      ),
      Effect.ensuring(Effect.sync(setup.cleanup)),
    );
  });

  it.live("does not stop when preparation fails", () => {
    const setup = fixture({ prepare: "fail" });
    return stackRestart(flags()).pipe(
      Effect.provide(setup.layer),
      Effect.flip,
      Effect.tap((error) =>
        Effect.sync(() => {
          expect(error.message).toContain("prepare failed");
          expect(setup.calls).toEqual(["prepare"]);
          expect(setup.telemetry.flushed).toBe(true);
        }),
      ),
      Effect.ensuring(Effect.sync(setup.cleanup)),
    );
  });

  it.live("does not start when stopping fails", () => {
    const setup = fixture({ stop: "fail" });
    return stackRestart(flags()).pipe(
      Effect.provide(setup.layer),
      Effect.flip,
      Effect.tap((error) =>
        Effect.sync(() => {
          expect(error.message).toContain("stop failed");
          expect(setup.calls).toEqual(["prepare", "stop"]);
        }),
      ),
      Effect.ensuring(Effect.sync(setup.cleanup)),
    );
  });

  it.live("leaves the stack stopped and recoverable when start fails", () => {
    const setup = fixture({ start: "fail" });
    return stackRestart(flags()).pipe(
      Effect.provide(setup.layer),
      Effect.flip,
      Effect.tap((error) =>
        Effect.sync(() => {
          expect(error.message).toContain("start failed");
          expect(setup.calls).toEqual(["prepare", "stop", "start"]);
          expect(setup.lifecycle).toBe("stopped");
          expect(setup.telemetry.flushed).toBe(true);
        }),
      ),
      Effect.ensuring(Effect.sync(setup.cleanup)),
    );
  });

  it.live("loads configuration from the persisted project root for an id target", () => {
    const setup = fixture({ idProject: true, format: "json" });
    return stackRestart(flags({ stackId: Option.some(id) })).pipe(
      Effect.provide(setup.layer),
      Effect.tap(() =>
        Effect.sync(() => {
          expect(setup.preparedConfig).toMatchObject({
            capabilities: { rest: { settings: { max_rows: 2345 } } },
          });
          expect(setup.output.messages.find(({ type }) => type === "success")?.data).toMatchObject({
            id,
            lifecycle: "running",
          });
        }),
      ),
      Effect.ensuring(Effect.sync(setup.cleanup)),
    );
  });

  it.live("fails invalid configuration before preparing or stopping", () => {
    const setup = fixture({ config: "invalid" });
    return stackRestart(flags()).pipe(
      Effect.provide(setup.layer),
      Effect.flip,
      Effect.tap((error) =>
        Effect.sync(() => {
          expect(error.reason).toBe("invalid-config");
          expect(setup.calls).toEqual([]);
        }),
      ),
      Effect.ensuring(Effect.sync(setup.cleanup)),
    );
  });

  it.live("fails without lifecycle calls when no existing stack is found", () => {
    const setup = fixture({ found: false });
    return stackRestart(flags()).pipe(
      Effect.provide(setup.layer),
      Effect.flip,
      Effect.tap((error) =>
        Effect.sync(() => {
          expect(error.reason).toBe("not-found");
          expect(setup.calls).toEqual([]);
        }),
      ),
      Effect.ensuring(Effect.sync(setup.cleanup)),
    );
  });

  it.live("selects a named existing stack", () => {
    const setup = fixture({});
    return stackRestart(flags({ stack: Option.some("feature-a") })).pipe(
      Effect.provide(setup.layer),
      Effect.tap(() => Effect.sync(() => expect(setup.selectedName).toBe("feature-a"))),
      Effect.ensuring(Effect.sync(setup.cleanup)),
    );
  });

  it.live("reports an actionable error for a missing named stack", () => {
    const setup = fixture({ found: false });
    return stackRestart(flags({ stack: Option.some("missing") })).pipe(
      Effect.provide(setup.layer),
      Effect.flip,
      Effect.tap((error) =>
        Effect.sync(() => {
          expect(setup.selectedName).toBe("missing");
          expect(error.message).toContain('No managed stack named "missing"');
          expect(error.suggestion).toContain("existing --stack name");
        }),
      ),
      Effect.ensuring(Effect.sync(setup.cleanup)),
    );
  });
});
