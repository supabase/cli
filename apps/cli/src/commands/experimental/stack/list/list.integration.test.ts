import { describe, expect, it } from "@effect/vitest";
import { BunServices } from "@effect/platform-bun";
import { Cause, Effect, Exit, Layer, Option } from "effect";
import { CliOutput, Command } from "effect/unstable/cli";
import {
  StackIdSchema,
  StackStateFormatUnsupportedError,
  type StackDescriptor,
} from "@supabase/stack/effect";
import { mockOutput } from "../../../../../tests/helpers/mocks.ts";
import { LegacyOutputFlag } from "../../../../shared/legacy/global-flags.ts";
import {
  actionability,
  ErrorActionabilityId,
} from "../../../../shared/telemetry/error-actionability.ts";
import { LegacyExperimentalStackApi } from "../stack.shared.ts";
import { legacyExperimentalStackList } from "./list.handler.ts";
import { LegacyExperimentalStackListError } from "./list.errors.ts";
import { legacyExperimentalStackListCommand } from "./list.command.ts";
import { textCliOutputFormatter } from "../../../../shared/output/text-formatter.ts";

const descriptor = (
  id: string,
  projectRoot: string,
  name: string,
  lifecycle: StackDescriptor["desiredLifecycle"],
) => ({
  id: StackIdSchema.make(id.repeat(64)),
  projectRoot,
  name,
  branchContext: `${name}-branch`,
  runtime: { kind: "native" as const },
  desiredLifecycle: lifecycle,
});

const runList = (
  stacks: ReadonlyArray<StackDescriptor>,
  options: { readonly legacyOutput?: boolean; readonly format?: "text" | "json" } = {},
) => {
  const out = mockOutput({ format: options.format });
  let listCalls = 0;
  let otherApiCalls = 0;
  const api = Layer.succeed(LegacyExperimentalStackApi, {
    createStack: () => {
      otherApiCalls++;
      return Effect.die("create must not run");
    },
    findStack: () => {
      otherApiCalls++;
      return Effect.succeed(Option.none());
    },
    listStacks: () =>
      Effect.sync(() => {
        listCalls++;
        return stacks;
      }),
    openStack: () => {
      otherApiCalls++;
      return Effect.die("open must not run");
    },
    inspectStack: () => {
      otherApiCalls++;
      return Effect.die("inspect must not run");
    },
  });
  const layer = Layer.mergeAll(
    out.layer,
    api,
    BunServices.layer,
    ...(options.legacyOutput ? [Layer.succeed(LegacyOutputFlag, Option.some("json"))] : []),
  );
  return {
    out,
    get listCalls() {
      return listCalls;
    },
    get otherApiCalls() {
      return otherApiCalls;
    },
    effect: legacyExperimentalStackList().pipe(Effect.provide(layer)),
  };
};

describe("experimental stack list", () => {
  it.effect(
    "sorts distinct persisted roots and reports stopped lifecycle without live claims",
    () => {
      const run = runList([
        descriptor("e", "/work/z", "zeta", "stopped"),
        descriptor("a", "/work/a", "beta", "running"),
        descriptor("c", "/work/a", "alpha", "unconfigured"),
        descriptor("b", "/work/a", "alpha", "stopped"),
      ]);
      return run.effect.pipe(
        Effect.tap(() =>
          Effect.sync(() => {
            expect(run.listCalls).toBe(1);
            expect(run.otherApiCalls).toBe(0);
            expect(run.out.stdoutText.indexOf("alpha")).toBeLessThan(
              run.out.stdoutText.indexOf("beta"),
            );
            expect(run.out.stdoutText).toContain("Desired lifecycle: stopped");
            expect(run.out.stdoutText).not.toContain("Readiness");
            expect(run.out.stdoutText).toContain("/work/z");
            expect(run.out.stdoutText).toContain(`alpha (${"b".repeat(64)})`);
            expect(run.out.stdoutText).toContain(`alpha (${"c".repeat(64)})`);
            expect(run.out.stdoutText.indexOf(`alpha (${"b".repeat(64)})`)).toBeLessThan(
              run.out.stdoutText.indexOf(`alpha (${"c".repeat(64)})`),
            );
          }),
        ),
      );
    },
  );

  it.effect("emits structured identity fields without secrets", () => {
    const run = runList([descriptor("d", "/work/secret", "safe", "stopped")], { format: "json" });
    return run.effect.pipe(
      Effect.tap(() =>
        Effect.sync(() => {
          expect(run.out.messages[0]?.data).toEqual({
            stacks: [
              {
                id: "d".repeat(64),
                project_root: "/work/secret",
                name: "safe",
                branch_context: "safe-branch",
                runtime: { kind: "native" },
                desired_lifecycle: "stopped",
              },
            ],
          });
        }),
      ),
    );
  });

  it.effect("renders the container engine in text output", () => {
    const run = runList([
      {
        ...descriptor("d", "/work/container", "podman", "stopped"),
        runtime: { kind: "container", engine: "podman" },
      },
    ]);
    return run.effect.pipe(
      Effect.tap(() =>
        Effect.sync(() => expect(run.out.stdoutText).toContain("Runtime: container (podman)")),
      ),
    );
  });

  it.effect("reports an empty registry", () => {
    const run = runList([]);
    return run.effect.pipe(
      Effect.tap(() =>
        Effect.sync(() => expect(run.out.stdoutText).toBe("No managed stacks found.\n")),
      ),
    );
  });

  it.effect("rejects legacy output without listing", () => {
    const run = runList([], { legacyOutput: true });
    return run.effect.pipe(
      Effect.exit,
      Effect.tap((legacyExit) =>
        Effect.sync(() => {
          expect(Exit.isFailure(legacyExit)).toBe(true);
          expect(run.listCalls).toBe(0);
          if (Exit.isFailure(legacyExit)) {
            const error = Cause.findErrorOption(legacyExit.cause);
            expect(Option.isSome(error)).toBe(true);
            if (Option.isSome(error) && error.value instanceof LegacyExperimentalStackListError) {
              expect(error.value.message).toContain("legacy -o/--output flag");
              expect(error.value.suggestion).toContain("--output-format");
              expect(error.value[ErrorActionabilityId]).toEqual(actionability.provideFlags);
            }
          }
        }),
      ),
    );
  });

  it.effect("preserves registry errors with actionable diagnostics", () => {
    const errorOut = mockOutput();
    const errorLayer = Layer.succeed(LegacyExperimentalStackApi, {
      createStack: () => Effect.die("unused"),
      findStack: () => Effect.succeed(Option.none()),
      listStacks: () =>
        Effect.fail(new StackStateFormatUnsupportedError({ message: "registry unreadable" })),
      openStack: () => Effect.die("unused"),
      inspectStack: () => Effect.die("unused"),
    });
    return legacyExperimentalStackList().pipe(
      Effect.provide(Layer.mergeAll(errorOut.layer, errorLayer, BunServices.layer)),
      Effect.exit,
      Effect.tap((errorExit) =>
        Effect.sync(() => {
          expect(Exit.isFailure(errorExit)).toBe(true);
          if (Exit.isFailure(errorExit)) {
            const error = Cause.findErrorOption(errorExit.cause);
            expect(Option.isSome(error)).toBe(true);
            if (Option.isSome(error) && error.value instanceof LegacyExperimentalStackListError) {
              expect(error.value.message).toBe("registry unreadable");
              expect(error.value.suggestion).toContain("managed stack registry");
              expect(error.value.cause).toBeInstanceOf(StackStateFormatUnsupportedError);
              expect(error.value[ErrorActionabilityId]).toEqual(actionability.invalidConfig);
            }
          }
        }),
      ),
    );
  });

  it.live("parses the list command through the command runner", () => {
    let called = false;
    const command = legacyExperimentalStackListCommand.pipe(
      Command.withHandler(() =>
        Effect.sync(() => {
          called = true;
        }),
      ),
    );
    return Effect.gen(function* () {
      yield* Command.runWith(command, { version: "0.0.0-test" })([]);
      expect(called).toBe(true);
    }).pipe(
      Effect.provide(Layer.mergeAll(BunServices.layer, CliOutput.layer(textCliOutputFormatter()))),
    );
  });
});
