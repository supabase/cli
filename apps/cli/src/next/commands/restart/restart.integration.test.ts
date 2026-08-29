import { describe, expect, it } from "@effect/vitest";
import { Effect, Exit, Layer, Option } from "effect";
import { StackIdSchema } from "@supabase/stack/effect";
import type { StackStatus } from "@supabase/stack/effect";
import { CAPABILITY_NAMES, StackUpgradeRequiredError } from "@supabase/stack/effect";
import { mockCliProjectHome, mockOutput, emptyEnv } from "../../../../tests/helpers/mocks.ts";
import { restart, type RestartOperations, type RestartStack } from "./restart.handler.ts";

const stackId = StackIdSchema.make(
  "fedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210",
);
const status: StackStatus = {
  id: stackId,
  lifecycle: "running",
  desiredLifecycle: "running",
  runtime: { kind: "native" },
  endpoints: {},
  versions: {},
  capabilities: CAPABILITY_NAMES.map((name) => ({
    name,
    activation: name === "functions" ? "lazy" : "eager",
    state: name === "functions" ? "dormant" : "ready",
  })),
};

describe("restart handler", () => {
  it.live("restarts the managed stack with translated config", () => {
    let receivedConfig: unknown;
    const output = mockOutput({ interactive: false });
    const stack: RestartStack = {
      restart: (options) =>
        Effect.sync(() => {
          receivedConfig = options?.config;
          return status;
        }),
    };
    const operations: RestartOperations = {
      findStack: () =>
        Effect.succeed(
          Option.some({
            id: stackId,
            projectRoot: process.cwd(),
            name: "default",
            branchContext: "refs/heads/main",
            runtime: { kind: "native" as const },
            desiredLifecycle: "running" as const,
          }),
        ),
      openStack: () => Effect.succeed(stack),
      loadConfig: () => Effect.succeed(undefined),
    };
    return restart({ stack: "default", exclude: ["auth"] }, operations).pipe(
      Effect.provide(
        Layer.mergeAll(
          emptyEnv(),
          output.layer,
          mockCliProjectHome({ projectRoot: process.cwd() }),
        ),
      ),
      Effect.tap(() =>
        Effect.sync(() => {
          expect(receivedConfig).toMatchObject({
            capabilities: { auth: { enabled: false } },
          });
          expect(output.messages).toContainEqual(
            expect.objectContaining({ message: "Local Supabase stack restarted." }),
          );
        }),
      ),
    );
  });

  it.live("propagates an upgrade-required restart failure", () => {
    const output = mockOutput({ interactive: false });
    const operations: RestartOperations = {
      findStack: () =>
        Effect.succeed(
          Option.some({
            id: stackId,
            projectRoot: process.cwd(),
            name: "default",
            branchContext: "refs/heads/main",
            runtime: { kind: "native" as const },
            desiredLifecycle: "running" as const,
          }),
        ),
      openStack: () =>
        Effect.succeed({
          restart: () =>
            Effect.fail(new StackUpgradeRequiredError({ message: "owner upgrade required" })),
        }),
      loadConfig: () => Effect.succeed(undefined),
    };
    return restart({ stack: "default", exclude: [] }, operations).pipe(
      Effect.provide(Layer.mergeAll(emptyEnv(), output.layer)),
      Effect.exit,
      Effect.tap((exit) =>
        Effect.sync(() => {
          expect(Exit.isFailure(exit)).toBe(true);
        }),
      ),
    );
  });
});
