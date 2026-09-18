import { NodeServices } from "@effect/platform-node";
import { describe, expect, it } from "@effect/vitest";
import { Cause, Effect, Exit, Option, Path, Redacted } from "effect";
import { compileServiceInstance } from "../model/Compiler.ts";
import type { PersistedStackState } from "../state/StackState.ts";
import { StackPreparationError } from "../public/Errors.ts";
import { databaseBootstrapPlan } from "./DatabaseBootstrapCatalog.ts";

const makeFixture = () =>
  Effect.gen(function* () {
    const path = yield* Path.Path;
    const compiled = yield* compileServiceInstance(
      {
        service: "database",
        config: { password: Redacted.make("database-secret"), settings: {} },
      },
      { projectRoot: "/tmp/database-bootstrap", path, runtime: { kind: "native" } },
    );
    const instance = compiled.instance;
    if (instance.service !== "database") return yield* Effect.die("database fixture missing");
    const passwordSlot = instance.config.passwordSecretRef;
    if (passwordSlot === undefined) return yield* Effect.die("database password slot missing");
    const state: PersistedStackState = {
      format: "supabase-stack-state-v2",
      identity: {
        projectRoot: "/tmp/database-bootstrap",
        branchContext: "test",
        stackName: "database-bootstrap",
      },
      runtime: { kind: "native" },
      preparation: "on-demand",
      security: {
        jwt: {
          issuer: null,
          expirySeconds: 3600,
          signing: { kind: "symmetric", secret: { slot: "secret:auth.jwt" } },
        },
      },
      listeners: {},
      registry: {
        initialized: true,
        instances: [instance],
        defaultInstanceIds: { database: instance.id },
      },
      ports: [],
      privatePorts: [
        {
          instanceId: instance.id,
          workloadId: `${instance.id}:database`,
          binding: "sql:internal",
          port: 5432,
        },
      ],
      secrets: {
        [passwordSlot]: { policy: "managed", value: "database-secret" },
        "secret:auth.jwt": { policy: "managed", value: "jwt-secret" },
      },
    };
    return { state, instance };
  });

const errorOf = <E>(exit: Exit.Exit<unknown, E>): E | undefined =>
  Exit.isFailure(exit) ? Option.getOrUndefined(Cause.findErrorOption(exit.cause)) : undefined;

describe("database bootstrap catalog", () => {
  it.live("returns managed material for the requested database instance", () =>
    Effect.gen(function* () {
      const { state, instance } = yield* makeFixture();
      const plan = yield* databaseBootstrapPlan(state, instance);
      expect(Redacted.value(plan.databasePassword)).toBe("database-secret");
      expect(Redacted.value(plan.jwtSecret)).toBe("jwt-secret");
      expect(plan.jwtExpiry).toBe(3600);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.live("rejects a missing instance password", () =>
    Effect.gen(function* () {
      const { state, instance } = yield* makeFixture();
      const missing = yield* databaseBootstrapPlan(
        { ...state, secrets: { "secret:auth.jwt": { policy: "managed", value: "jwt-secret" } } },
        instance,
      ).pipe(Effect.exit);
      const error = errorOf(missing);
      expect(error).toBeInstanceOf(StackPreparationError);
      expect(error).toMatchObject({
        message: "Managed database password is unavailable for bootstrap",
      });
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.live("rejects a missing shared JWT secret", () =>
    Effect.gen(function* () {
      const { state, instance } = yield* makeFixture();
      const missing = yield* databaseBootstrapPlan(
        {
          ...state,
          secrets: Object.fromEntries(
            Object.entries(state.secrets).filter(([slot]) => slot !== "secret:auth.jwt"),
          ),
        },
        instance,
      ).pipe(Effect.exit);
      const error = errorOf(missing);
      expect(error).toBeInstanceOf(StackPreparationError);
      expect(error).toMatchObject({
        message: "Managed JWT secret is unavailable for database bootstrap",
      });
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.live("rejects an invalid shared JWT expiry", () =>
    Effect.gen(function* () {
      const { state, instance } = yield* makeFixture();
      const invalid = yield* databaseBootstrapPlan(
        { ...state, security: { jwt: { ...state.security.jwt, expirySeconds: 0 } } },
        instance,
      ).pipe(Effect.exit);
      const error = errorOf(invalid);
      expect(error).toBeInstanceOf(StackPreparationError);
      expect(error).toMatchObject({ message: "Auth JWT expiry must be a finite positive integer" });
    }).pipe(Effect.provide(NodeServices.layer)),
  );
});
