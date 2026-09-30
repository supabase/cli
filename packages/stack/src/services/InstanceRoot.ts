import { Effect, type FileSystem, type Path } from "effect";

/** The container mount target for an instance-scoped directory owned on the host. */
export const containerInstancePath = "/instance";

const safeInstanceIdPattern = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/u;

/** True when `instanceId` is safe to join to a root as one path segment, without traversal. */
export const isSafeInstanceId = (instanceId: string): boolean =>
  safeInstanceIdPattern.test(instanceId);

export interface OwnedInstanceRootParams {
  readonly fs: FileSystem.FileSystem;
  readonly path: Path.Path;
  readonly root: string;
  readonly stackId: string;
  readonly instanceId: string;
  readonly ownerFileName: string;
  /** Names `root` in error messages, e.g. "Database root". */
  readonly label: string;
}

/** Claims `root` for one stack+instance pair, failing if another instance already owns it. */
export const ensureOwnedInstanceRoot = Effect.fn("InstanceRoot.ensureOwnedInstanceRoot")(<E>(
  params: OwnedInstanceRootParams,
  onError: (operation: string, cause: unknown) => E,
): Effect.Effect<void, E> => {
  const { fs, path, root, stackId, instanceId, ownerFileName, label } = params;
  const ownerFile = path.join(root, ownerFileName);
  const marker = JSON.stringify({ stackId, instanceId });
  return Effect.gen(function* () {
    if (!isSafeInstanceId(instanceId))
      return yield* Effect.fail(onError("data", `${label} instance id is not a safe path segment`));
    yield* fs
      .makeDirectory(root, { recursive: true, mode: 0o700 })
      .pipe(Effect.mapError((cause) => onError("data", cause)));
    const present = yield* fs
      .exists(ownerFile)
      .pipe(Effect.mapError((cause) => onError("data", cause)));
    if (present) {
      const existing = yield* fs
        .readFileString(ownerFile)
        .pipe(Effect.mapError((cause) => onError("data", cause)));
      if (existing !== marker)
        return yield* Effect.fail(onError("data", `${label} belongs to another instance`));
    } else {
      const entries = yield* fs
        .readDirectory(root)
        .pipe(Effect.mapError((cause) => onError("data", cause)));
      if (entries.length > 0)
        return yield* Effect.fail(onError("data", `${label} is non-empty and unmarked`));
      yield* fs
        .writeFileString(ownerFile, marker, { mode: 0o600, flag: "wx" })
        .pipe(Effect.mapError((cause) => onError("data", cause)));
    }
  });
});

/** Removes `root` for one stack+instance pair after running `removeData`, keeping any `keep` entries. */
export const removeOwnedInstanceRoot = Effect.fn("InstanceRoot.removeOwnedInstanceRoot")(<E>(
  params: OwnedInstanceRootParams,
  removeData: Effect.Effect<void, E>,
  onError: (operation: string, cause: unknown) => E,
  /** Root entries kept with the owner marker; when empty the root itself is removed. */
  keep: ReadonlyArray<string> = [],
): Effect.Effect<void, E> => {
  const { fs, path, root, stackId, instanceId, ownerFileName, label } = params;
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
