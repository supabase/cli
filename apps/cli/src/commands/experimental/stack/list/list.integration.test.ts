import { BunServices } from "@effect/platform-bun";
import { describe, expect, it } from "@effect/vitest";
import { Effect, Layer, Option } from "effect";
import {
  StackIdSchema,
  StackStateFormatUnsupportedError,
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
  discoveryError?: StackDiscoveryIssue["error"];
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
          options.discoveryError === undefined
            ? Effect.succeed({ stacks: options.stacks ?? [], errors: options.errors ?? [] })
            : Effect.fail(options.discoveryError),
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

  it.live("renders every healthy stack and every discovery issue", () => {
    const healthy = descriptor("a", "/work", "main", "running");
    const fixture = setup({
      stacks: [healthy],
      errors: [
        {
          id: StackIdSchema.make("d".repeat(64)),
          error: new StackStateInvalidError({ message: "corrupt state" }),
        },
        {
          id: StackIdSchema.make("c".repeat(64)),
          error: new StackStateFormatUnsupportedError({ message: "unsupported format" }),
        },
      ],
    });
    return stackList().pipe(
      Effect.tap(() =>
        Effect.sync(() => {
          expect(fixture.output.stdoutText).toContain("main");
          expect(fixture.output.stdoutText).toContain(`Unreadable stack (${"c".repeat(64)})`);
          expect(fixture.output.stdoutText).toContain(`Unreadable stack (${"d".repeat(64)})`);
          expect(fixture.output.stdoutText).toContain("corrupt state");
          expect(fixture.output.stdoutText).toContain("unsupported format");
          expect(fixture.output.stdoutText.indexOf("main")).toBeLessThan(
            fixture.output.stdoutText.indexOf(`Unreadable stack (${"c".repeat(64)})`),
          );
          expect(
            fixture.output.stdoutText.indexOf(`Unreadable stack (${"c".repeat(64)})`),
          ).toBeLessThan(fixture.output.stdoutText.indexOf(`Unreadable stack (${"d".repeat(64)})`));
          expect(fixture.telemetry.flushed).toBe(true);
        }),
      ),
      Effect.provide(fixture.layer),
    );
  });

  it.live("reports only unreadable stacks without inventing metadata", () => {
    const first = StackIdSchema.make("b".repeat(64));
    const second = StackIdSchema.make("a".repeat(64));
    const fixture = setup({
      errors: [
        { id: first, error: new StackStateInvalidError({ message: "bad state" }) },
        { id: second, error: new StackStateFormatUnsupportedError({ message: "bad format" }) },
      ],
    });
    return stackList().pipe(
      Effect.tap(() =>
        Effect.sync(() => {
          expect(fixture.output.stdoutText).toContain(`Unreadable stack (${second})`);
          expect(fixture.output.stdoutText).toContain(`Unreadable stack (${first})`);
          expect(fixture.output.stdoutText.indexOf(`Unreadable stack (${second})`)).toBeLessThan(
            fixture.output.stdoutText.indexOf(`Unreadable stack (${first})`),
          );
          expect(fixture.output.stdoutText).not.toContain("Project:");
          expect(fixture.output.stdoutText).not.toContain("No managed stacks found.");
        }),
      ),
      Effect.provide(fixture.layer),
    );
  });

  it.live("emits the complete discriminated inventory in json and stream-json", () =>
    Effect.forEach(["json", "stream-json"] as const, (outputFormat) => {
      const healthy = descriptor("a", "/work", "main", "running");
      const issue = {
        id: StackIdSchema.make("b".repeat(64)),
        error: new StackStateInvalidError({ message: "corrupt state" }),
      };
      const fixture = setup({ outputFormat, stacks: [healthy], errors: [issue] });
      return stackList().pipe(
        Effect.tap(() =>
          Effect.sync(() => {
            expect(fixture.output.messages).toEqual(
              expect.arrayContaining([
                expect.objectContaining({
                  type: "success",
                  data: {
                    stacks: [
                      {
                        id: healthy.id,
                        readable: true,
                        project_root: healthy.projectRoot,
                        name: healthy.name,
                        branch_context: healthy.branchContext,
                        runtime: healthy.runtime,
                        desired_lifecycle: healthy.desiredLifecycle,
                      },
                      {
                        id: issue.id,
                        readable: false,
                        error: { code: "StackStateInvalidError", message: "corrupt state" },
                      },
                    ],
                  },
                }),
              ]),
            );
            expect(fixture.telemetry.flushed).toBe(true);
          }),
        ),
        Effect.provide(fixture.layer),
      );
    }),
  );

  it.live("fails registry discovery without emitting a partial result", () => {
    const fixture = setup({
      discoveryError: new StackStateInvalidError({ message: "registry unavailable" }),
    });
    return stackList().pipe(
      Effect.flip,
      Effect.tap((error) =>
        Effect.sync(() => {
          expect(error.message).toContain("registry unavailable");
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
