import { readdir, readFile } from "node:fs/promises";
import { Data, Effect } from "effect";
import {
  type BundleManifest,
  decodeBundleManifest,
  decodeRootManifest,
  type RootManifest,
} from "./Manifest.ts";
import { type BundleIndex, makeBundleIndex } from "./Resolution.ts";

export class BundleStoreError extends Data.TaggedError("BundleStoreError")<{
  readonly path: string;
  readonly cause: unknown;
}> {}

export interface BundleStore {
  readonly root: RootManifest;
  readonly index: BundleIndex;
}

const readJson = (path: string): Effect.Effect<unknown, BundleStoreError> =>
  Effect.tryPromise({
    try: async () => JSON.parse(await readFile(path, "utf8")) as unknown,
    catch: (cause) => new BundleStoreError({ path, cause }),
  });

const listDirs = (path: string): Effect.Effect<ReadonlyArray<string>, BundleStoreError> =>
  Effect.tryPromise({
    try: async () => {
      const entries = await readdir(path, { withFileTypes: true });
      return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name);
    },
    catch: (cause) => new BundleStoreError({ path, cause }),
  });

/**
 * Load `manifest.json` plus every bundle manifest under a bundle root
 * (`<root>/<lineage>/<service>/<version>/manifest.json`). Decoding failures
 * surface loudly instead of silently dropping a bundle: a malformed manifest
 * means the tree is broken, not that a version is unavailable.
 */
export const loadBundleStore = (rootDir: string): Effect.Effect<BundleStore, BundleStoreError> =>
  Effect.gen(function* () {
    const root = yield* readJson(`${rootDir}/manifest.json`).pipe(
      Effect.flatMap((json) =>
        decodeRootManifest(json).pipe(
          Effect.mapError(
            (cause) => new BundleStoreError({ path: `${rootDir}/manifest.json`, cause }),
          ),
        ),
      ),
    );
    const manifests: Array<BundleManifest> = [];
    for (const lineage of root.lineages) {
      const lineageDir = `${rootDir}/${lineage}`;
      for (const service of yield* listDirs(lineageDir)) {
        for (const version of yield* listDirs(`${lineageDir}/${service}`)) {
          const manifestPath = `${lineageDir}/${service}/${version}/manifest.json`;
          const manifest = yield* readJson(manifestPath).pipe(
            Effect.flatMap((json) =>
              decodeBundleManifest(json).pipe(
                Effect.mapError((cause) => new BundleStoreError({ path: manifestPath, cause })),
              ),
            ),
          );
          manifests.push(manifest);
        }
      }
    }
    return { root, index: makeBundleIndex(manifests) };
  });
