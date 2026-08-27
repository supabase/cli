import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { Effect, FileSystem, Option, Schema } from "effect";
import type { WorkerDeploySpec, WorkerRecord } from "./workers-api.ts";

/**
 * What `push` remembers about the last deploy it made, so the next one can tell
 * a worker it already deployed from one it has not.
 *
 * The Workers API has no deployment identifier: `POST .../deploy` answers 202
 * with the same worker resource `GET` returns, and nothing in it names the
 * deploy that produced it. So the two questions `push` needs answered — "is
 * this bundle already deployed?" and "is the record I am polling mine or the
 * previous version's?" — are answered from a fingerprint computed here and the
 * `image_version` the last deploy settled on.
 *
 * State lives in `supabase/.temp/`, beside the linked-project ref and the other
 * caches the CLI keeps per checkout. It is a cache, not a source of truth: a
 * missing, stale or unreadable file only ever costs a redeploy, and every skip
 * is confirmed against the remote worker before it is taken.
 */

const WorkerDeployStateSchema = Schema.Struct({
  worker: Schema.String,
  project_ref: Schema.String,
  /** See {@link workerDeployFingerprint}. */
  fingerprint: Schema.String,
  /** The image the fingerprinted deploy settled on; absent if it reported none. */
  image_version: Schema.optionalKey(Schema.String),
  /** Recorded for anyone reading the file; the comparison is the fingerprint. */
  spec: Schema.Struct({
    runtime: Schema.optionalKey(Schema.String),
    size: Schema.String,
    exposure: Schema.String,
    instances: Schema.Number,
  }),
});

export type WorkerDeployState = Schema.Schema.Type<typeof WorkerDeployStateSchema>;

export interface WorkerDeployStateKey {
  readonly projectRoot: string;
  readonly projectRef: string;
  readonly name: string;
}

/**
 * `supabase/.temp/workers/<ref>/<name>.json`.
 *
 * Keyed by project ref as well as name because one checkout is regularly pushed
 * at more than one project (a branch, a staging ref via `--project-ref`), and a
 * single file per worker would have each deploy invalidate the other's record.
 */
function workerDeployStatePath(key: WorkerDeployStateKey): string {
  return join(key.projectRoot, "supabase", ".temp", "workers", key.projectRef, `${key.name}.json`);
}

/**
 * The identity of a deploy: what would go into the image, plus the spec it
 * would run under.
 *
 * The spec is in here because a worker whose code has not changed still has to
 * be redeployed when its size or instance count has — `--instances 3` on an
 * unchanged bundle is a real change to make.
 */
export function workerDeployFingerprint(options: {
  readonly contentDigest: string;
  readonly spec: WorkerDeploySpec;
}): string {
  // Assembled by hand rather than by spreading `spec`, so the field order is a
  // property of this function and not of whatever built the spec object.
  const spec = {
    runtime: options.spec.runtime ?? null,
    size: options.spec.size,
    exposure: options.spec.exposure,
    instances: options.spec.instances,
  };

  const hash = createHash("sha256");
  // Versioned: changing what goes into the hash has to invalidate every
  // recorded fingerprint rather than silently match against the old scheme.
  hash.update("supabase-worker-deploy/1\n");
  hash.update(`${options.contentDigest}\n`);
  hash.update(JSON.stringify(spec));
  return `sha256:${hash.digest("hex")}`;
}

/** The recorded state, or `None` when there is none this CLI can read. */
export const readWorkerDeployState = Effect.fnUntraced(function* (key: WorkerDeployStateKey) {
  const fs = yield* FileSystem.FileSystem;

  const text = yield* fs.readFileString(workerDeployStatePath(key)).pipe(Effect.option);
  if (Option.isNone(text)) {
    return Option.none<WorkerDeployState>();
  }

  // A file written by a newer CLI, half-written by a killed process, or edited
  // by hand reads as "nothing recorded" — the only cost is a deploy that would
  // otherwise have been skipped.
  return yield* Effect.try(() => JSON.parse(text.value) as unknown).pipe(
    Effect.flatMap(Schema.decodeUnknownEffect(WorkerDeployStateSchema)),
    Effect.option,
  );
});

/**
 * Record a completed deploy.
 *
 * Failures are the caller's to ignore: the deploy has already happened by the
 * time this runs, and a `.temp` that cannot be written (a read-only checkout, a
 * CI cache mount) should cost the next push its skip, not report the deploy
 * that succeeded as failed.
 */
export const writeWorkerDeployState = Effect.fnUntraced(function* (
  key: WorkerDeployStateKey,
  state: WorkerDeployState,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = workerDeployStatePath(key);
  const encoded = yield* Schema.encodeEffect(WorkerDeployStateSchema)(state);

  yield* fs.makeDirectory(dirname(path), { recursive: true });
  yield* fs.writeFileString(path, `${JSON.stringify(encoded, null, 2)}\n`);
});

/**
 * The image a worker is already running when the deploy about to happen would
 * be a no-op, or `None` when there is something to deploy.
 *
 * An image rather than a boolean because that image *is* the verdict's
 * evidence: it is what the caller reports as the deployed version, and it only
 * exists when all three of the following agree — the local record alone proves
 * nothing about the project being pushed at:
 *
 * - the fingerprint matches, so neither the source nor the spec has changed;
 * - the remote worker is `active` on exactly the image that fingerprint
 *   produced, so nobody has deleted, redeployed or rolled it back since;
 * - the size, exposure and instance count the API reports are the ones we are
 *   about to send, so a rescale from the dashboard is still a change to make.
 *
 * Anything else — no record, no remote worker, a worker mid-build or failed, an
 * image the record does not name — deploys.
 */
export function workerDeployUnchangedImage(options: {
  readonly recorded: Option.Option<WorkerDeployState>;
  readonly remote: WorkerRecord;
  readonly fingerprint: string;
  readonly spec: WorkerDeploySpec;
}): Option.Option<string> {
  if (Option.isNone(options.recorded)) {
    return Option.none();
  }
  const recorded = options.recorded.value;
  const remote = options.remote;

  if (recorded.fingerprint !== options.fingerprint) {
    return Option.none();
  }
  if (remote.buildState !== "active" || remote.deleting === true) {
    return Option.none();
  }
  // An image version neither side reports is not a match — it is two unknowns,
  // and skipping on it would strand a worker whose image had moved underneath.
  if (recorded.image_version === undefined || remote.imageVersion !== recorded.image_version) {
    return Option.none();
  }

  // `runtime` is left out on purpose: the API reports one for every worker,
  // including the `dockerfile` builds this CLI sends no runtime for, so
  // comparing it would refuse to skip anything built from a Dockerfile. A
  // runtime change is a source change too, and the fingerprint has it.
  const specMatches =
    remote.spec.size === options.spec.size &&
    remote.spec.exposure === options.spec.exposure &&
    remote.spec.instances === options.spec.instances;

  return specMatches ? Option.some(recorded.image_version) : Option.none();
}
