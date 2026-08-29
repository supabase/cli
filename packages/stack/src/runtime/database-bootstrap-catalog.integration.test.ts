import { NodeServices } from "@effect/platform-node";
import { describe, expect, it } from "@effect/vitest";
import { Cause, Effect, Exit, Option, Redacted } from "effect";
import { compileStack } from "../model/Compiler.ts";
import type { PersistedStackState } from "../state/StackState.ts";
import { StackPreparationError } from "../public/Errors.ts";
import { DATABASE_BOOTSTRAP_REVISION, databaseBootstrapPlan } from "./DatabaseBootstrapCatalog.ts";

const stackId = "a".repeat(64);

const stateFrom = (definition: PersistedStackState["definition"]): PersistedStackState => ({
  format: "supabase-stack-state-v1",
  identity: {
    stackId,
    projectRoot: "/tmp/project",
    checkoutRoot: "/tmp/project",
    workspaceId: "/tmp/project",
    checkoutId: "/tmp/project",
    branchContext: "ordinary-workspace",
    localProjectKey: ".",
    stackName: "default",
  },
  runtime: { kind: "native" },
  desiredGeneration: 1,
  portsGeneration: 1,
  desiredLifecycle: "stopped",
  definition,
  inputFingerprint: "b".repeat(64),
  ports: [],
  privatePorts: [{ workloadId: "database:database", binding: "primary", port: 54_321 }],
  secrets: {
    "secret:database.internal.password": { policy: "managed", value: "database-secret" },
    "secret:auth.settings.jwt_secret": { policy: "managed", value: "jwt-secret" },
  },
});

const compileDefinition = compileStack({
  projectRoot: "/tmp/project",
  runtime: { kind: "native" },
}).pipe(
  Effect.provide(NodeServices.layer),
  Effect.map((result) => stateFrom(result.definition)),
);

const errorOf = <E>(exit: Exit.Exit<unknown, E>): E | undefined =>
  Exit.isFailure(exit) ? Option.getOrUndefined(Cause.findErrorOption(exit.cause)) : undefined;

describe("database bootstrap catalog", () => {
  it.live("creates one revision and reconciles all closed roles and settings", () =>
    Effect.gen(function* () {
      const state = yield* compileDefinition;
      const plan = yield* databaseBootstrapPlan(state);
      expect(plan.revisions).toEqual([DATABASE_BOOTSTRAP_REVISION]);
      expect(Object.keys(plan.credentials?.roles ?? {})).toHaveLength(7);
      for (const password of Object.values(plan.credentials?.roles ?? {}))
        expect(password === undefined ? undefined : Redacted.value(password)).toBe(
          "database-secret",
        );
      expect(plan.settings?.jwtExpiry).toBe(3600);
      expect(
        plan.settings === undefined ? undefined : Redacted.value(plan.settings.jwtSecret),
      ).toBe("jwt-secret");
    }),
  );

  it.live("fails closed when secret material is absent or JWT expiry is invalid", () =>
    Effect.gen(function* () {
      const state = yield* compileDefinition;
      const missing = yield* databaseBootstrapPlan({ ...state, secrets: {} }).pipe(Effect.exit);
      const missingError = errorOf(missing);
      expect(missingError).toBeInstanceOf(StackPreparationError);
      expect(String(missingError)).not.toContain("database-secret");

      if (state.definition === undefined) return;
      const invalidDefinition = {
        ...state.definition,
        capabilities: {
          ...state.definition.capabilities,
          auth: {
            ...state.definition.capabilities.auth,
            settings: { ...state.definition.capabilities.auth.settings, jwt_expiry: 0 },
          },
        },
      };
      const invalid = yield* databaseBootstrapPlan({
        ...state,
        definition: invalidDefinition,
      }).pipe(Effect.exit);
      const invalidError = errorOf(invalid);
      expect(invalidError).toBeInstanceOf(StackPreparationError);
      expect(String(invalidError)).not.toContain("jwt-secret");
    }),
  );
});
