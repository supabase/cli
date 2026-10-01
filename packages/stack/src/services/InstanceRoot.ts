import { Effect, type FileSystem, type Path } from "effect";
import { randomUUID } from "node:crypto";

/** The container mount target for an instance-scoped directory owned on the host. */
export const containerInstancePath = "/instance";

const safeInstanceIdPattern = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/u;

/** True when `instanceId` is safe to join to a root as one path segment, without traversal. */
const isSafeInstanceId = (instanceId: string): boolean => safeInstanceIdPattern.test(instanceId);

export interface OwnedInstanceRootParams {
  readonly fs: FileSystem.FileSystem;
  readonly path: Path.Path;
  /** Parent directory the instance-scoped root is joined under, as `<parentRoot>/<instanceId>`. */
  readonly parentRoot: string;
  readonly stackId: string;
  readonly instanceId: string;
  readonly ownerFileName: string;
  /** Names the owned instance root in error messages, e.g. "Database root". */
  readonly label: string;
}

/** Claims `<parentRoot>/<instanceId>` for one stack+instance pair, failing if another instance already owns it. */
export const ensureOwnedInstanceRoot = Effect.fn("InstanceRoot.ensureOwnedInstanceRoot")(<E>(
  params: OwnedInstanceRootParams,
  onError: (operation: string, cause: unknown) => E,
): Effect.Effect<void, E> => {
  const { fs, path, parentRoot, stackId, instanceId, ownerFileName, label } = params;
  const root = path.join(parentRoot, instanceId);
  const ownerFile = path.join(root, ownerFileName);
  const marker = JSON.stringify({ stackId, instanceId });
  const claimExistingMarker = Effect.gen(function* () {
    const existing = yield* fs
      .readFileString(ownerFile)
      .pipe(Effect.mapError((cause) => onError("data", cause)));
    if (existing !== marker)
      return yield* Effect.fail(onError("data", `${label} belongs to another instance`));
  });
  // A direct exclusive create on `ownerFile` lets readers observe it mid-write (open and write
  // are separate syscalls); writing it fully to a temp file first and hard-linking it into place
  // keeps the exclusivity of `wx` without ever exposing a partial file.
  const writeMarkerAtomically = Effect.suspend(() => {
    const tempFile = path.join(parentRoot, `.${instanceId}.${ownerFileName}.${randomUUID()}.tmp`);
    return fs.writeFileString(tempFile, marker, { mode: 0o600, flag: "wx" }).pipe(
      Effect.andThen(() => fs.link(tempFile, ownerFile)),
      Effect.catchIf(
        (error) => error.reason._tag === "AlreadyExists",
        () => Effect.void,
      ),
      Effect.ensuring(fs.remove(tempFile, { force: true }).pipe(Effect.ignore)),
      Effect.mapError((cause) => onError("data", cause)),
    );
  });
  return Effect.gen(function* () {
    if (!isSafeInstanceId(instanceId))
      return yield* Effect.fail(onError("data", `${label} instance id is not a safe path segment`));
    yield* fs
      .makeDirectory(root, { recursive: true, mode: 0o700 })
      .pipe(Effect.mapError((cause) => onError("data", cause)));
    const present = yield* fs
      .exists(ownerFile)
      .pipe(Effect.mapError((cause) => onError("data", cause)));
    if (present) return yield* claimExistingMarker;
    const entries = yield* fs
      .readDirectory(root)
      .pipe(Effect.mapError((cause) => onError("data", cause)));
    if (entries.length > 0) {
      // A concurrent first claim may have written the marker between the `exists` and
      // `readDirectory` calls above; an otherwise-empty root is still safe to compare.
      if (entries.length === 1 && entries[0] === ownerFileName) return yield* claimExistingMarker;
      return yield* Effect.fail(onError("data", `${label} is non-empty and unmarked`));
    }
    yield* writeMarkerAtomically;
    return yield* claimExistingMarker;
  });
});

/** Removes `<parentRoot>/<instanceId>` for one stack+instance pair after running `removeData`, keeping any `keep` entries. */
export const removeOwnedInstanceRoot = Effect.fn("InstanceRoot.removeOwnedInstanceRoot")(<E>(
  params: OwnedInstanceRootParams,
  removeData: Effect.Effect<void, E>,
  onError: (operation: string, cause: unknown) => E,
  /** Root entries kept with the owner marker; when empty the root itself is removed. */
  keep: ReadonlyArray<string> = [],
): Effect.Effect<void, E> => {
  const { fs, path, parentRoot, stackId, instanceId, ownerFileName, label } = params;
  const root = path.join(parentRoot, instanceId);
  const ownerFile = path.join(root, ownerFileName);
  const marker = JSON.stringify({ stackId, instanceId });
  return Effect.gen(function* () {
    if (!isSafeInstanceId(instanceId))
      return yield* Effect.fail(
        onError("destroy", `${label} instance id is not a safe path segment`),
      );
    const present = yield* fs
      .exists(ownerFile)
      .pipe(Effect.mapError((cause) => onError("destroy", cause)));
    if (!present) {
      if (yield* fs.exists(root).pipe(Effect.mapError((cause) => onError("destroy", cause))))
        return yield* Effect.fail(onError("destroy", `${label} is unmarked`));
      return;
    }
    const existing = yield* fs
      .readFileString(ownerFile)
      .pipe(Effect.mapError((cause) => onError("destroy", cause)));
    if (existing !== marker)
      return yield* Effect.fail(onError("destroy", `${label} belongs to another instance`));
    yield* removeData;
    if (keep.length === 0)
      return yield* fs
        .remove(root, { recursive: true, force: true })
        .pipe(Effect.mapError((cause) => onError("destroy", cause)));
    const names = yield* fs
      .readDirectory(root)
      .pipe(Effect.mapError((cause) => onError("destroy", cause)));
    for (const name of names)
      if (name !== path.basename(ownerFile) && !keep.includes(name))
        yield* fs
          .remove(path.join(root, name), { recursive: true, force: true })
          .pipe(Effect.mapError((cause) => onError("destroy", cause)));
  });
});
