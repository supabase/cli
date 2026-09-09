import { describe, expect, it } from "@effect/vitest";
import { Effect, Layer, Option, Redacted, Stream } from "effect";
import { CAPABILITY_NAMES, StackIdSchema, type EffectStack } from "@supabase/stack/effect";
import { mockCommandSettings, useTempWorkdir } from "../../../../tests/helpers/command-mocks.ts";
import { stackBackendLayer } from "./stack-backend.ts";
import { stackLocalDatabaseUrl } from "./stack-local-database.ts";
import { StackApi } from "./stack.shared.ts";

const tmp = useTempWorkdir("stack-local-db-");
const STACK_ID = StackIdSchema.make("a".repeat(64));

const unused = () => Effect.die("unused");

const stack: EffectStack = {
  id: STACK_ID,
  status: () =>
    Effect.succeed({
      id: STACK_ID,
      lifecycle: "running",
      desiredLifecycle: "running",
      runtime: { kind: "native" },
      endpoints: {},
      versions: {},
      capabilities: CAPABILITY_NAMES.map((name) => ({
        name,
        activation: name === "database" ? "eager" : "lazy",
        state: name === "database" ? "ready" : "dormant",
      })),
      artifacts: [],
    }),
  credentials: () =>
    Effect.succeed({
      database: {
        url: Redacted.make("postgresql://postgres:secret@127.0.0.1:54329/postgres"),
        password: Redacted.make("secret"),
      },
      api: {
        publishableKey: "anon",
        secretKey: Redacted.make("service"),
        anonJwt: "anon",
        serviceRoleJwt: Redacted.make("service"),
      },
    }),
  prepare: unused,
  start: unused,
  stop: unused,
  destroy: unused,
  logs: unused,
  followLogs: () => Stream.empty,
};

describe("stackLocalDatabaseUrl", () => {
  it.effect("returns the project stack database URL when the database is ready", () => {
    const api = Layer.succeed(StackApi, {
      createStack: unused,
      findStack: () =>
        Effect.succeed(
          Option.some({
            id: STACK_ID,
            projectRoot: tmp.current,
            name: "default",
            branchContext: "main",
            runtime: { kind: "native" },
            desiredLifecycle: "running",
          }),
        ),
      discoverStacks: unused,
      openStack: () => Effect.succeed(stack),
      inspectStack: unused,
    });
    return Effect.gen(function* () {
      expect(yield* stackLocalDatabaseUrl).toBe(
        "postgresql://postgres:secret@127.0.0.1:54329/postgres",
      );
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          mockCommandSettings({ workdir: tmp.current }),
          stackBackendLayer("stack"),
          api,
        ),
      ),
    );
  });
});
