import { BunServices } from "@effect/platform-bun";
import { describe, expect, it } from "@effect/vitest";
import { Effect, Layer, Option } from "effect";
import {
  StackIdSchema,
  StackStateInvalidError,
  type StackDescriptor,
  type StackDiscoveryIssue,
} from "@supabase/stack/effect";
import { OutputFlag } from "../../../../command-internal/global-flags.ts";
import { mockTelemetryStateTracked } from "../../../../../tests/helpers/command-mocks.ts";
import { mockOutput } from "../../../../../tests/helpers/mocks.ts";
import { StackApi } from "../stack.shared.ts";
import { stackList } from "./list.handler.ts";
import { StackCommandListError } from "./list.errors.ts";

const descriptor = (
  id: string,
  projectRoot: string,
  name: string,
  desiredLifecycle: StackDescriptor["desiredLifecycle"],
): StackDescriptor => ({
  id: StackIdSchema.make(id.repeat(64)),
  projectRoot,
  name,
  branchContext: `${name}-branch`,
  runtime: { kind: "native" },
  desiredLifecycle,
});

const setup = (options: {
  stacks?: ReadonlyArray<StackDescriptor>;
  errors?: ReadonlyArray<StackDiscoveryIssue>;
  outputFormat?: "text" | "json" | "stream-json";
  outputFlag?: boolean;
}) => {
  const output = mockOutput({ format: options.outputFormat });
  const telemetry = mockTelemetryStateTracked();
  return {
    output,
    telemetry,
    layer: Layer.mergeAll(
      output.layer,
      telemetry.layer,
      Layer.succeed(StackApi, {
        findStack: () => Effect.die("unused"),
        createStack: () => Effect.die("unused"),
        openStack: () => Effect.die("unused"),
        inspectStack: () => Effect.die("unused"),
        discoverStacks: () =>
          Effect.succeed({ stacks: options.stacks ?? [], errors: options.errors ?? [] }),
      }),
      ...(options.outputFlag ? [Layer.succeed(OutputFlag, Option.some("json"))] : []),
      BunServices.layer,
    ),
  };
};

describe("stack list", () => {
  it.live("sorts persisted stacks and includes stopped and unconfigured lifecycles", () => {
    const fixture = setup({
      stacks: [
        descriptor("e", "/work/z", "zeta", "stopped"),
        descriptor("a", "/work/a", "beta", "running"),
        descriptor("c", "/work/a", "alpha", "unconfigured"),
        descriptor("b", "/work/a", "alpha", "stopped"),
      ],
    });
    return stackList().pipe(
      Effect.tap(() =>
        Effect.sync(() => {
          expect(fixture.output.stdoutText.indexOf("alpha")).toBeLessThan(
            fixture.output.stdoutText.indexOf("beta"),
          );
          expect(fixture.output.stdoutText.indexOf("alpha (bbbb")).toBeLessThan(
            fixture.output.stdoutText.indexOf("alpha (cccc"),
          );
          expect(fixture.output.stdoutText).toContain("Desired lifecycle: stopped");
          expect(fixture.output.stdoutText).toContain("Desired lifecycle: unconfigured");
          expect(fixture.telemetry.flushed).toBe(true);
        }),
      ),
      Effect.provide(fixture.layer),
    );
  });

  it.live("reports an empty registry", () => {
    const fixture = setup({});
    return stackList().pipe(
      Effect.tap(() =>
        Effect.sync(() => expect(fixture.output.stdoutText).toBe("No managed stacks found.\n")),
      ),
      Effect.provide(fixture.layer),
    );
  });

  it.live("emits structured stack descriptors", () => {
    const stack = descriptor("a", "/work", "main", "running");
    const fixture = setup({
      outputFormat: "json",
      stacks: [stack],
    });
    return stackList().pipe(
      Effect.tap(() =>
        Effect.sync(() =>
          expect(fixture.output.messages).toEqual(
            expect.arrayContaining([
              expect.objectContaining({
                type: "success",
                data: {
                  stacks: [
                    {
                      id: stack.id,
                      project_root: stack.projectRoot,
                      name: stack.name,
                      branch_context: stack.branchContext,
                      runtime: stack.runtime,
                      desired_lifecycle: stack.desiredLifecycle,
                    },
                  ],
                },
              }),
            ]),
          ),
        ),
      ),
      Effect.provide(fixture.layer),
    );
  });

  it.live("fails discovery without emitting a partial result", () => {
    const fixture = setup({
      stacks: [descriptor("a", "/work", "main", "running")],
      errors: [
        {
          id: StackIdSchema.make("b".repeat(64)),
          error: new StackStateInvalidError({ message: "corrupt state" }),
        },
      ],
    });
    return stackList().pipe(
      Effect.flip,
      Effect.tap((error) =>
        Effect.sync(() => {
          expect(error.message).toContain("corrupt state");
          expect(fixture.output.stdoutText).toBe("");
          expect(fixture.output.messages).toHaveLength(0);
          expect(fixture.telemetry.flushed).toBe(true);
        }),
      ),
      Effect.provide(fixture.layer),
    );
  });

  it.live("rejects the legacy output flag", () => {
    const fixture = setup({ outputFlag: true });
    return stackList().pipe(
      Effect.flip,
      Effect.tap((error) =>
        Effect.sync(() => {
          expect(error).toBeInstanceOf(StackCommandListError);
          expect(error.reason).toBe("flags");
          expect(fixture.telemetry.flushed).toBe(true);
        }),
      ),
      Effect.provide(fixture.layer),
    );
  });
});
