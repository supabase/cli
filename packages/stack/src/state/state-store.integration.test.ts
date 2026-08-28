import { NodeServices } from "@effect/platform-node";
import { describe, expect, it } from "@effect/vitest";
import { Cause, Effect, Exit, FileSystem, Option, Path, Redacted, Schema } from "effect";
import { compileStack, type StackDefinition } from "../model/Compiler.ts";
import { deriveStackId } from "../identity/Identity.ts";
import {
  StackStateFormatUnsupportedError,
  StackStateGenerationMismatchError,
  StackStateInvalidError,
} from "../public/Errors.ts";
import {
  makeStackStateStore,
  PersistedStackStateSchema,
  type PersistedStackState,
} from "./StackStateStore.ts";

const layer = NodeServices.layer;
const withPlatform = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.scoped(effect).pipe(Effect.provide(layer));

const identity = {
  projectRoot: "/tmp/project",
  checkoutRoot: "/tmp/project",
  workspaceId: "/tmp/project",
  checkoutId: "/tmp/project",
  branchContext: "ordinary-workspace",
  localProjectKey: ".",
  stackName: "default",
} as const;

const state = (
  stackId: string,
  generation = 0,
  definition?: StackDefinition,
): PersistedStackState => ({
  format: "supabase-stack-state-v1",
  identity: { ...identity, stackId },
  runtime: { kind: "native" },
  desiredGeneration: generation,
  desiredLifecycle: "stopped",
  definition,
  inputFingerprint: definition === undefined ? undefined : "d".repeat(64),
  ports: [],
  secrets: {},
});

const errorOf = <E>(exit: Exit.Exit<unknown, E>): E | undefined =>
  Exit.isFailure(exit) ? Option.getOrUndefined(Cause.findErrorOption(exit.cause)) : undefined;
const jsonText = (value: unknown) =>
  Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))(value);

describe("atomic stack state", () => {
  it.live("round-trips a compiled complete definition and rejects nested unknowns", () =>
    withPlatform(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "supabase-stack-state-" });
        const store = yield* makeStackStateStore({ stateRoot: root });
        const stackId = yield* deriveStackId(identity);
        const compiled = yield* compileStack({
          projectRoot: "/tmp/project",
          runtime: { kind: "native" },
          config: {
            capabilities: {
              auth: {
                settings: {
                  secret_key: Redacted.make("state-secret"),
                  email: {
                    template: { confirm: { subject: "Confirm" } },
                    notification: { welcome: { enabled: true } },
                  },
                },
              },
              functions: { settings: { functions: { hello: { verify_jwt: false } } } },
            },
          },
        });
        const complete = state(stackId, 2, compiled.definition);
        yield* store.write(stackId, complete);
        expect(yield* store.read(stackId)).toEqual(complete);

        const encoded = yield* Schema.encodeEffect(PersistedStackStateSchema)(complete);
        const statePath = path.join(root, stackId, "state.json");
        const nestedUnknown = {
          ...encoded,
          definition: {
            ...encoded.definition,
            capabilities: {
              ...encoded.definition?.capabilities,
              auth: {
                ...encoded.definition?.capabilities.auth,
                settings: {
                  ...encoded.definition?.capabilities.auth.settings,
                  email: {
                    ...encoded.definition?.capabilities.auth.settings.email,
                    template: {
                      ...encoded.definition?.capabilities.auth.settings.email?.template,
                      confirm: {
                        ...encoded.definition?.capabilities.auth.settings.email?.template?.confirm,
                        unknown: true,
                      },
                    },
                  },
                },
              },
            },
          },
        };
        yield* fs.writeFileString(statePath, yield* jsonText(nestedUnknown));
        const unknownExit = yield* store.read(stackId).pipe(Effect.exit);
        expect(errorOf(unknownExit)).toBeInstanceOf(StackStateInvalidError);

        const missingDefault = {
          ...encoded,
          definition: {
            ...encoded.definition,
            capabilities: {
              ...encoded.definition?.capabilities,
              functions: {
                ...encoded.definition?.capabilities.functions,
                settings: {
                  ...encoded.definition?.capabilities.functions.settings,
                  functions: {
                    ...encoded.definition?.capabilities.functions.settings.functions,
                    hello: {
                      ...encoded.definition?.capabilities.functions.settings.functions?.hello,
                      verify_jwt: undefined,
                    },
                  },
                },
              },
            },
          },
        };
        yield* fs.writeFileString(statePath, yield* jsonText(missingDefault));
        const missingDefaultExit = yield* store.read(stackId).pipe(Effect.exit);
        expect(errorOf(missingDefaultExit)).toBeInstanceOf(StackStateInvalidError);

        const invalidRecordKey = {
          ...encoded,
          definition: {
            ...encoded.definition,
            capabilities: {
              ...encoded.definition?.capabilities,
              functions: {
                ...encoded.definition?.capabilities.functions,
                settings: {
                  ...encoded.definition?.capabilities.functions.settings,
                  functions: {
                    "bad.slug": {
                      enabled: true,
                      verify_jwt: true,
                      import_map: null,
                      entrypoint: null,
                      static_files: null,
                      env: {},
                    },
                  },
                },
              },
            },
          },
        };
        yield* fs.writeFileString(statePath, yield* jsonText(invalidRecordKey));
        const recordExit = yield* store.read(stackId).pipe(Effect.exit);
        expect(errorOf(recordExit)).toBeInstanceOf(StackStateInvalidError);

        const invalidSecret = {
          ...encoded,
          secrets: { "": { policy: "managed", value: "x" } },
        };
        yield* fs.writeFileString(statePath, yield* jsonText(invalidSecret));
        const secretExit = yield* store.read(stackId).pipe(Effect.exit);
        expect(errorOf(secretExit)).toBeInstanceOf(StackStateInvalidError);
      }),
    ),
  );

  it.live("fails closed when identity remnants exist without state and cleans exact identity", () =>
    withPlatform(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "supabase-stack-remnant-" });
        const store = yield* makeStackStateStore({ stateRoot: root });
        const stackId = yield* deriveStackId(identity);
        yield* fs.makeDirectory(path.join(root, stackId, "data"), { recursive: true });
        const sibling = yield* deriveStackId({ ...identity, stackName: "sibling" });
        yield* fs.makeDirectory(path.join(root, sibling, "data"), { recursive: true });
        const missing = yield* store.read(stackId).pipe(Effect.exit);
        expect(errorOf(missing)).toBeInstanceOf(StackStateInvalidError);
        yield* store.cleanup(stackId);
        expect(yield* fs.exists(path.join(root, stackId))).toBe(false);
        expect(yield* fs.exists(path.join(root, sibling, "data"))).toBe(true);
      }),
    ),
  );

  it.live("rejects unsupported format and stale generation mutations", () =>
    withPlatform(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "supabase-stack-generation-" });
        const store = yield* makeStackStateStore({ stateRoot: root });
        const stackId = yield* deriveStackId(identity);
        yield* store.write(stackId, state(stackId, 4));
        const stale = yield* store.replace(stackId, state(stackId, 5), 3).pipe(Effect.exit);
        expect(errorOf(stale)).toBeInstanceOf(StackStateGenerationMismatchError);
        yield* fs.writeFileString(
          path.join(root, stackId, "state.json"),
          yield* jsonText({ ...state(stackId, 4), format: "supabase-stack-state-v2" }),
        );
        const unsupported = yield* store.read(stackId).pipe(Effect.exit);
        expect(errorOf(unsupported)).toBeInstanceOf(StackStateFormatUnsupportedError);
        yield* fs.writeFileString(
          path.join(root, stackId, "state.json"),
          yield* jsonText({ ...state(stackId, 4), format: 1 }),
        );
        const malformed = yield* store.read(stackId).pipe(Effect.exit);
        expect(errorOf(malformed)).toBeInstanceOf(StackStateInvalidError);
      }),
    ),
  );

  it.live("rejects a forged identity tuple before writing", () =>
    withPlatform(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "supabase-stack-identity-" });
        const store = yield* makeStackStateStore({ stateRoot: root });
        const stackId = yield* deriveStackId(identity);
        const original = state(stackId);
        const forged = {
          ...original,
          identity: { ...original.identity, workspaceId: "/tmp/forged" },
        };
        const exit = yield* store.write(stackId, forged).pipe(Effect.exit);
        expect(errorOf(exit)).toBeInstanceOf(StackStateInvalidError);
        expect(yield* fs.exists(path.join(root, stackId))).toBe(false);
      }),
    ),
  );

  it.live("exposes only complete old or new values during repeated writes", () =>
    withPlatform(
      Effect.gen(function* () {
        const root = yield* (yield* FileSystem.FileSystem).makeTempDirectoryScoped({
          prefix: "supabase-stack-atomic-",
        });
        const store = yield* makeStackStateStore({ stateRoot: root });
        const stackId = yield* deriveStackId(identity);
        yield* store.write(stackId, state(stackId, 0));
        const updates = Array.from({ length: 8 }, (_, index) =>
          store.replace(stackId, state(stackId, index + 1), index),
        );
        const writer = Effect.forEach(updates, (update) => update, { concurrency: 1 });
        const readers = Effect.forEach(Array.from({ length: 32 }), () => store.read(stackId), {
          concurrency: 8,
        });
        const [, observations] = yield* Effect.all([writer, readers], { concurrency: 2 });
        const allowedGenerations = new Set(
          Array.from({ length: 9 }, (_, generation) => generation),
        );
        for (const observation of observations) {
          expect(observation).toBeDefined();
          if (observation === undefined) continue;
          expect(allowedGenerations.has(observation.desiredGeneration)).toBe(true);
          expect(observation.format).toBe("supabase-stack-state-v1");
          expect(observation.identity.stackId).toBe(stackId);
          expect(Array.isArray(observation.ports)).toBe(true);
          expect(observation.secrets).toEqual({});
        }
      }),
    ),
  );
});
