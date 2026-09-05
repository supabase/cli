import { Effect, Path, Schema } from "effect";
import { InvalidProjectRootError, InvalidStackIdentityError } from "../public/Errors.ts";
import { StackIdSchema, type StackId } from "../public/StackId.ts";

export interface StackPaths {
  /** The exact `<stateRoot>/<StackId>` directory. */
  readonly stackRoot: string;
  /** Durable state document; temporary replacements are siblings of this path. */
  readonly stateDocument: string;
  readonly data: string;
  readonly logs: string;
  readonly runtime: string;
  /** Control metadata owned by the identity's supervisor. */
  readonly controlMetadata: string;
}

export interface ResolveStackPathsOptions {
  readonly stateRoot: string;
  readonly stackId: StackId;
}

/**
 * Resolves all durable and runtime paths under one validated StackId.
 *
 * This function only computes names. It does not create directories or touch
 * the filesystem, so callers can use it from read-only discovery paths.
 */
export const resolveStackPaths = (
  options: ResolveStackPathsOptions,
): Effect.Effect<StackPaths, InvalidProjectRootError | InvalidStackIdentityError, Path.Path> =>
  Effect.gen(function* () {
    const path = yield* Path.Path;
    if (options.stateRoot.trim().length === 0) {
      return yield* new InvalidProjectRootError({
        stateRoot: options.stateRoot,
        message: "The stack state root must not be blank",
      });
    }

    const stackId = yield* Schema.decodeEffect(StackIdSchema)(options.stackId).pipe(
      Effect.mapError(
        (error) =>
          new InvalidStackIdentityError({
            stackId: options.stackId,
            message: `Invalid StackId: ${String(error)}`,
          }),
      ),
    );
    const stateRoot = path.resolve(options.stateRoot);
    const stackRoot = path.join(stateRoot, stackId);
    const stateDocument = path.join(stackRoot, "state.json");
    return {
      stackRoot,
      stateDocument,
      data: path.join(stackRoot, "data"),
      logs: path.join(stackRoot, "logs"),
      runtime: path.join(stackRoot, "runtime"),
      controlMetadata: path.join(stackRoot, "control.json"),
    };
  });
