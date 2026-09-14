import { NodeServices } from "@effect/platform-node";
import { describe, expect, it } from "@effect/vitest";
import { Cause, Effect, Exit, FileSystem, Option, Path, Redacted } from "effect";
import { makePromiseApi } from "./PromiseStack.ts";
import { createStack, inspectStack } from "./EffectStack.ts";
import {
  defaultRuntimeEnvironment,
  StackRuntimeEnvironment,
  type StackRuntimeEnvironmentValue,
} from "../supervisor/Launcher.ts";
import { compileStack } from "../model/Compiler.ts";
import { makeStackStateStore } from "../state/StackStateStore.ts";
import type { StackConfig } from "./Config.ts";
import { StackVersionUnsupportedError, InvalidStackConfigError } from "./Errors.ts";

const withRuntimeRoot = <A, E, R>(effect: (project: string) => Effect.Effect<A, E, R>) =>
  Effect.scoped(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectory({ prefix: "supabase-config-drift-" });
      yield* Effect.addFinalizer(() =>
        fs.remove(root, { recursive: true, force: true }).pipe(Effect.ignore),
      );
      const project = path.join(root, "project");
      yield* fs.makeDirectory(project);
      const defaults = yield* defaultRuntimeEnvironment;
      const runtime: StackRuntimeEnvironmentValue = {
        ...defaults,
        stateRoot: path.join(root, "managed", "stacks"),
        tempRoot: "/tmp",
        platform: "posix",
      };
      return yield* effect(project).pipe(Effect.provideService(StackRuntimeEnvironment, runtime));
    }),
  ).pipe(Effect.provide(NodeServices.layer));

const seedConfiguredStack = (projectRoot: string, config: StackConfig) =>
  Effect.gen(function* () {
    const stack = yield* createStack({ projectRoot, runtime: { kind: "native" } });
    const env = yield* StackRuntimeEnvironment;
    const store = yield* makeStackStateStore({ stateRoot: env.stateRoot });
    const state = yield* store.read(stack.id);
    if (state === undefined) return yield* Effect.die("stack state was not initialized");
    const compiled = yield* compileStack({
      projectRoot: state.identity.projectRoot,
      runtime: state.runtime,
      config,
    });
    const secrets = Object.fromEntries(
      compiled.secrets.map((entry) => [
        entry.slot,
        {
          policy: entry.policy,
          value: entry.value === undefined ? "generated" : String(Redacted.value(entry.value)),
        },
      ]),
    );
    yield* store.replace(stack.id, { ...state, definition: compiled.definition, secrets });
    return stack;
  });

const baseConfig = (secret: string): StackConfig => ({
  capabilities: {
    functions: {
      settings: {
        functions_root: "supabase/functions",
        edge_runtime: { secrets: { TOKEN: Redacted.make(secret) } },
      },
    },
  },
  listeners: { api: { port: 55431 } },
});

describe("inspectStack config drift", () => {
  it.live(
    "reports unchanged and changed settings, preparation, listeners, and secret paths without values",
    () =>
      withRuntimeRoot((projectRoot) =>
        Effect.gen(function* () {
          const stack = yield* seedConfiguredStack(projectRoot, baseConfig("old-secret"));
          const unchanged = yield* inspectStack(stack.id, { config: baseConfig("old-secret") });
          expect(unchanged.configDrift).toEqual({
            status: "unchanged",
            paths: [],
          });

          const changed = yield* inspectStack(stack.id, {
            config: {
              ...baseConfig("new-secret"),
              preparation: "on-demand",
              capabilities: {
                functions: {
                  settings: {
                    functions_root: "supabase/functions",
                    edge_runtime: {
                      policy: "oneshot",
                      secrets: { TOKEN: Redacted.make("new-secret") },
                    },
                  },
                },
              },
              listeners: { api: { port: 55432 } },
            },
          });
          expect(changed.configDrift?.status).toBe("changed");
          expect(changed.configDrift?.paths).toEqual(
            expect.arrayContaining([
              "definition.preparation",
              "definition.capabilities.functions.settings.edge_runtime.policy",
              "definition.listeners.api.port",
              "secrets.secret:functions.settings.edge_runtime.secrets.TOKEN",
            ]),
          );
          // oxlint-disable-next-line effecttsgo/prefer-schema-over-json -- assertion checks redaction of serialized output
          expect(JSON.stringify(changed.configDrift)).not.toContain("old-secret");
          // oxlint-disable-next-line effecttsgo/prefer-schema-over-json -- assertion checks redaction of serialized output
          expect(JSON.stringify(changed.configDrift)).not.toContain("new-secret");
        }),
      ),
  );

  it.live("marks an unconfigured stack", () =>
    withRuntimeRoot((projectRoot) =>
      Effect.gen(function* () {
        const stack = yield* createStack({ projectRoot, runtime: { kind: "native" } });
        const unconfigured = yield* inspectStack(stack.id, { config: {} });
        expect(unconfigured.configDrift).toEqual({
          status: "unconfigured",
          paths: [],
        });
      }),
    ),
  );

  it.live(
    "reuses omitted managed secrets and detects explicit changes or passthrough removal",
    () =>
      withRuntimeRoot((projectRoot) =>
        Effect.gen(function* () {
          const managed = (secret?: string): StackConfig => ({
            ...baseConfig("old-secret"),
            capabilities: {
              auth: { settings: secret === undefined ? {} : { jwt_secret: Redacted.make(secret) } },
              functions: baseConfig("old-secret").capabilities?.functions,
            },
          });
          const stack = yield* seedConfiguredStack(projectRoot, managed("managed-secret"));
          expect((yield* inspectStack(stack.id, { config: managed() })).configDrift).toEqual({
            status: "unchanged",
            paths: [],
          });
          const changed = yield* inspectStack(stack.id, { config: managed("new-managed-secret") });
          expect(changed.configDrift?.paths).toContain("secrets.secret:auth.settings.jwt_secret");
          // oxlint-disable-next-line effecttsgo/prefer-schema-over-json -- assertion checks redaction of serialized output
          expect(JSON.stringify(changed.configDrift)).not.toContain("managed-secret");
          const removed = yield* inspectStack(stack.id, {
            config: {
              ...baseConfig("old-secret"),
              capabilities: {
                functions: { settings: { functions_root: "supabase/functions", edge_runtime: {} } },
              },
            },
          });
          expect(removed.configDrift?.paths).toContain(
            "secrets.secret:functions.settings.edge_runtime.secrets.TOKEN",
          );
        }),
      ),
  );

  it.live("rejects malformed candidate config with a typed config error", () =>
    withRuntimeRoot((projectRoot) =>
      Effect.gen(function* () {
        const stack = yield* seedConfiguredStack(projectRoot, baseConfig("old-secret"));
        const result = yield* inspectStack(stack.id, {
          config: { capabilities: { database: { version: "unsupported" } } },
        }).pipe(Effect.exit);
        expect(Exit.isFailure(result)).toBe(true);
        if (Exit.isFailure(result)) {
          const failure = Cause.findErrorOption(result.cause);
          expect(Option.isSome(failure)).toBe(true);
          if (Option.isSome(failure)) {
            expect(failure.value).toBeInstanceOf(StackVersionUnsupportedError);
            expect(failure.value).not.toBeInstanceOf(InvalidStackConfigError);
          }
        }
      }),
    ),
  );

  it.live("decodes Promise facade config and returns the same redacted report", () =>
    withRuntimeRoot((projectRoot) =>
      Effect.gen(function* () {
        const stack = yield* seedConfiguredStack(projectRoot, baseConfig("old-secret"));
        const env = yield* StackRuntimeEnvironment;
        const api = makePromiseApi(NodeServices.layer, env);
        return yield* Effect.tryPromise(() =>
          api.inspectStack(stack.id, { config: { listeners: { api: { port: 55432 } } } }),
        );
      }).pipe(
        Effect.tap((inspection) =>
          Effect.sync(() => {
            expect(inspection.configDrift?.status).toBe("changed");
            // oxlint-disable-next-line effecttsgo/prefer-schema-over-json -- assertion checks redaction of serialized output
            expect(JSON.stringify(inspection.configDrift)).not.toContain("old-secret");
          }),
        ),
      ),
    ),
  );
});
