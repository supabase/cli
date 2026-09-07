import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BunServices } from "@effect/platform-bun";
import { describe, expect, it } from "@effect/vitest";
import { Cause, Effect, Exit, Layer, Option } from "effect";
import {
  InvalidStackConfigError,
  StackIdSchema,
  StackStateFormatUnsupportedError,
  type StackInspection,
  type StackStatus,
} from "@supabase/stack/effect";
import { mockOutput } from "../../../../../tests/helpers/mocks.ts";
import { mockLegacyCliSettings } from "../../../../../tests/helpers/legacy-mocks.ts";
import { LegacyOutputFlag } from "../../../../shared/legacy/global-flags.ts";
import {
  actionability,
  ErrorActionabilityId,
} from "../../../../shared/telemetry/error-actionability.ts";
import { LegacyExperimentalStackApi } from "../stack.shared.ts";
import { legacyExperimentalStackStatus } from "./status.handler.ts";

const id = StackIdSchema.make("a".repeat(64));
const capabilityNames = [
  "database",
  "rest",
  "auth",
  "realtime",
  "storage",
  "functions",
  "studio",
  "mail",
  "analytics",
  "pooler",
] as const;
const flags = (stack = Option.none<string>(), stackId = Option.none<string>()) => ({
  stack,
  stackId,
});

const makeStatus = (stackId: typeof id): StackStatus => ({
  id: stackId,
  lifecycle: "running",
  desiredLifecycle: "running",
  runtime: { kind: "native" },
  endpoints: {
    api: { protocol: "http", address: "127.0.0.1", port: 54321, url: "http://127.0.0.1:54321" },
  },
  versions: {},
  capabilities: capabilityNames.map((name) => ({
    name,
    activation: "lazy" as const,
    state: "dormant" as const,
  })),
  artifacts: [],
});

const runStatus = (options: {
  readonly config?: "valid" | "missing" | "invalid";
  readonly owner?: StackInspection["owner"];
  readonly status?: StackStatus;
  readonly drift?: StackInspection["configDrift"];
  readonly flags?: ReturnType<typeof flags>;
  readonly compareFailure?: "typed" | "defect";
  readonly legacyOutput?: boolean;
}) => {
  const root = mkdtempSync(join(tmpdir(), "supabase-stack-status-"));
  const projectRoot = join(root, "project");
  mkdirSync(join(projectRoot, "supabase"), { recursive: true });
  if (options.config !== "missing")
    writeFileSync(
      join(projectRoot, "supabase", "config.toml"),
      options.config === "invalid"
        ? 'project_id = "unterminated\n'
        : 'project_id = "status-test"\n\n[auth]\njwt_secret = "candidate-secret"\n',
    );
  const descriptor = {
    id,
    projectRoot,
    name: "feature-a",
    branchContext: "ordinary-workspace",
    runtime: { kind: "native" as const },
    desiredLifecycle: "running" as const,
  };
  const inspection: StackInspection = {
    descriptor,
    owner: options.owner ?? "running",
    ...(options.status === undefined ? {} : { status: options.status }),
    ...(options.drift === undefined ? {} : { configDrift: options.drift }),
  };
  const out = mockOutput();
  const findInputs: unknown[] = [];
  const inspectInputs: unknown[] = [];
  const api = Layer.succeed(LegacyExperimentalStackApi, {
    createStack: () => Effect.die("create must not run"),
    findStack: (input) => {
      findInputs.push(input);
      return Effect.succeed(Option.some(descriptor));
    },
    openStack: () => Effect.die("open must not run"),
    inspectStack: (_stackId, inspectOptions) => {
      inspectInputs.push(inspectOptions);
      if (inspectOptions?.config !== undefined && options.compareFailure === "typed")
        return Effect.fail(new InvalidStackConfigError({ message: "candidate config is invalid" }));
      if (inspectOptions?.config !== undefined && options.compareFailure === "defect")
        return Effect.die("comparison defect");
      return Effect.succeed(inspection);
    },
  });
  const layer = Layer.mergeAll(
    out.layer,
    api,
    mockLegacyCliSettings({ workdir: root }),
    ...(options.legacyOutput === true
      ? [Layer.succeed(LegacyOutputFlag, Option.some("json"))]
      : []),
    BunServices.layer,
  );
  const effect = legacyExperimentalStackStatus(options.flags ?? flags()).pipe(
    Effect.provide(layer),
    Effect.ensuring(Effect.sync(() => rmSync(root, { recursive: true, force: true }))),
  );
  return { effect, out, findInputs, inspectInputs, projectRoot, root };
};

describe("experimental stack status", () => {
  it.effect(
    "reports configured identity, dormant readiness, endpoint, drift, and target config",
    () => {
      const run = runStatus({
        status: makeStatus(id),
        drift: { status: "changed", paths: ["definition.listeners.api.port"] },
      });
      return run.effect.pipe(
        Effect.tap(() =>
          Effect.sync(() => {
            expect(run.findInputs).toEqual([{ projectRoot: expect.any(String) }]);
            expect(run.inspectInputs).toHaveLength(1);
            expect(run.inspectInputs[0]).toEqual({ config: expect.any(Object) });
            expect(run.out.stdoutText).toContain("Runtime: native");
            expect(run.out.stdoutText).toContain("Readiness: dormant");
            expect(run.out.stdoutText).toContain("http://127.0.0.1:54321");
            expect(run.out.stdoutText).toContain("definition.listeners.api.port");
            expect(run.out.stdoutText).not.toContain("candidate-secret");
          }),
        ),
      );
    },
  );

  it.effect("uses the persisted project root for an explicit id from another cwd", () => {
    const run = runStatus({ flags: flags(Option.none(), Option.some(id)), status: makeStatus(id) });
    return run.effect.pipe(
      Effect.tap(() =>
        Effect.sync(() => {
          expect(run.inspectInputs).toHaveLength(2);
          expect(run.inspectInputs[1]).toEqual({ config: expect.any(Object) });
        }),
      ),
    );
  });

  it.effect("reports stopped and unreachable stacks without claiming live readiness", () => {
    const run = runStatus({ owner: "absent" });
    return run.effect.pipe(
      Effect.tap(() =>
        Effect.sync(() => {
          expect(run.out.stdoutText).toContain("Lifecycle: unavailable");
          expect(run.out.stdoutText).toContain("Desired lifecycle: running");
          expect(run.out.stdoutText).toContain("Readiness: unknown");
        }),
      ),
    );
  });

  it.effect("reports unavailable drift for missing or invalid config and keeps inspection", () => {
    const missing = runStatus({ config: "missing", status: makeStatus(id) });
    const invalid = runStatus({ config: "invalid", status: makeStatus(id) });
    return Effect.all([missing.effect, invalid.effect]).pipe(
      Effect.tap(() =>
        Effect.sync(() => {
          expect(missing.out.stdoutText).toContain("Config drift: unavailable");
          expect(invalid.out.stdoutText).toContain("Config drift: unavailable");
        }),
      ),
    );
  });

  it.effect("falls back only for typed comparison errors and preserves defects", () => {
    const typed = runStatus({ compareFailure: "typed", status: makeStatus(id) });
    const defect = runStatus({ compareFailure: "defect", status: makeStatus(id) });
    return Effect.gen(function* () {
      yield* typed.effect;
      expect(typed.inspectInputs).toHaveLength(2);
      expect(typed.out.stdoutText).toContain("Config drift: unavailable");
      const exit = yield* defect.effect.pipe(Effect.exit);
      expect(Exit.isFailure(exit)).toBe(true);
      expect(defect.inspectInputs).toHaveLength(1);
    });
  });

  it.effect("rejects invalid flags and legacy output before discovery", () => {
    const invalid = runStatus({ flags: flags(Option.some("feature-a"), Option.some(id)) });
    const legacy = runStatus({ legacyOutput: true });
    return Effect.gen(function* () {
      expect(Exit.isFailure(yield* invalid.effect.pipe(Effect.exit))).toBe(true);
      expect(Exit.isFailure(yield* legacy.effect.pipe(Effect.exit))).toBe(true);
      expect(invalid.findInputs).toHaveLength(0);
      expect(legacy.findInputs).toHaveLength(0);
    });
  });

  it.effect("does not retry discovery failures", () => {
    const run = runStatus({});
    const discovery = Layer.succeed(LegacyExperimentalStackApi, {
      createStack: () => Effect.die("create must not run"),
      findStack: () =>
        Effect.fail(new StackStateFormatUnsupportedError({ message: "discovery failed" })),
      openStack: () => Effect.die("open must not run"),
      inspectStack: () => Effect.die("inspect must not run"),
    });
    const effect = legacyExperimentalStackStatus(flags()).pipe(
      Effect.provide(
        Layer.mergeAll(
          run.out.layer,
          discovery,
          mockLegacyCliSettings({ workdir: run.projectRoot }),
          BunServices.layer,
        ),
      ),
      Effect.ensuring(Effect.sync(() => rmSync(run.root, { recursive: true, force: true }))),
      Effect.exit,
    );
    return effect.pipe(
      Effect.tap((exit) =>
        Effect.sync(() => {
          expect(Exit.isFailure(exit)).toBe(true);
          if (Exit.isFailure(exit)) {
            const error = Cause.findErrorOption(exit.cause);
            expect(Option.isSome(error)).toBe(true);
            if (Option.isSome(error))
              expect(error.value[ErrorActionabilityId]).toEqual(actionability.invalidConfig);
          }
        }),
      ),
    );
  });
});
