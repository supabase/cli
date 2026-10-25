import { BunPath, BunServices } from "@effect/platform-bun";
import { Effect, FileSystem, Layer, Path } from "effect";

const LEGACY_STATE_SEGMENT = Effect.runSync(
  Effect.gen(function* () {
    const path = yield* Path.Path;
    return path.join("supabase", ".temp");
  }).pipe(Effect.provide(BunPath.layer)),
);

/** Wrong-on-purpose values for every `supabase/.temp` file a stack-mode command might still read. */
const LEGACY_STATE_DECOYS: Readonly<Record<string, string>> = {
  "project-ref": "decoyprojectrefabcdef",
  "pooler-url": "postgresql://decoy:decoy@decoy.pooler.invalid:6543/postgres",
  "linked-project.json": JSON.stringify({ ref: "decoyprojectrefabcdef", name: "decoy" }),
  "postgres-version": "99.99.99.999",
  "rest-version": "v99.99.99",
  "gotrue-version": "v99.99.99",
  "storage-api": "v99.99.99",
  "storage-version": "v99.99.99",
  "storage-migration": "decoy-migration",
  "realtime-version": "v99.99.99",
  "studio-version": "99.99.99",
  "pgmeta-version": "v99.99.99",
  "logflare-version": "99.99.99",
  "pooler-version": "99.99.99",
  "edge-runtime-version": "v99.99.99",
  "cli-latest": "v99.99.99",
};

/** Writes the decoys into `<root>/supabase/.temp`, outside any recording filesystem. */
export const seedLegacyStateDecoys = (root: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const dir = path.join(root, LEGACY_STATE_SEGMENT);
    yield* fs.makeDirectory(dir, { recursive: true });
    for (const [name, value] of Object.entries(LEGACY_STATE_DECOYS)) {
      yield* fs.writeFileString(path.join(dir, name), value);
    }
  }).pipe(
    /* A host failure surfaces as the raw host error. */
    Effect.catchTag("PlatformError", (error) => Effect.die(error.cause ?? error)),
    Effect.provide(BunServices.layer),
  );

/** The recorded paths that fall under a `supabase/.temp` directory. */
export function legacyStateAccesses(accessed: ReadonlyArray<string>): ReadonlyArray<string> {
  return accessed.filter((entry) => entry.includes(LEGACY_STATE_SEGMENT));
}

/**
 * A `FileSystem` that records every path argument it is handed, then delegates to the real one.
 * Merge it through `buildTestRuntime({ fileSystem })` so every service in the runtime goes
 * through it. It sees only the Effect `FileSystem`, so code that uses node:fs needs its own
 * assertion that the decoys stay untouched.
 */
export function recordingFileSystem(): {
  readonly layer: Layer.Layer<FileSystem.FileSystem>;
  readonly accessed: Array<string>;
} {
  const accessed: Array<string> = [];
  const layer = Layer.effect(
    FileSystem.FileSystem,
    Effect.map(
      FileSystem.FileSystem,
      (real) =>
        new Proxy<FileSystem.FileSystem>(real, {
          get(target, property, receiver) {
            const value: unknown = Reflect.get(target, property, receiver);
            if (typeof value !== "function") return value;
            return (...args: ReadonlyArray<unknown>) => {
              for (const arg of args) {
                if (typeof arg === "string") accessed.push(arg);
                else if (typeof arg === "object" && arg !== null) {
                  const directory: unknown = Reflect.get(arg, "directory");
                  if (typeof directory === "string") accessed.push(directory);
                }
              }
              return Reflect.apply(value, target, args);
            };
          },
        }),
    ),
  ).pipe(Layer.provide(BunServices.layer));
  return { layer, accessed };
}
