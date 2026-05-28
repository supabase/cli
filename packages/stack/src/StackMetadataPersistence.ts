import { Effect, Layer, Context } from "effect";
import type { CleanupTargets } from "./CleanupTargets.ts";
import {
  StateManager,
  type InvalidStackMetadataError,
  type UnsupportedStackMetadataVersionError,
} from "./StateManager.ts";

type PersistCleanupTargetsError = InvalidStackMetadataError | UnsupportedStackMetadataVersionError;

export class StackMetadataPersistence extends Context.Service<
  StackMetadataPersistence,
  {
    readonly persistCleanupTargets: (
      cleanupTargets: CleanupTargets,
    ) => Effect.Effect<void, PersistCleanupTargetsError>;
  }
>()("stack/StackMetadataPersistence") {
  static noop: Layer.Layer<StackMetadataPersistence> = Layer.succeed(this, {
    persistCleanupTargets: () => Effect.void,
  });

  static fromStateManager = (
    name: string,
  ): Layer.Layer<StackMetadataPersistence, never, StateManager> =>
    Layer.effect(
      this,
      Effect.gen(function* () {
        const stateManager = yield* StateManager;
        return {
          persistCleanupTargets: (cleanupTargets: CleanupTargets) =>
            stateManager
              .updateMetadata(name, (metadata) => ({
                ...metadata,
                cleanupTargets,
                updatedAt: new Date().toISOString(),
              }))
              .pipe(Effect.catchTag("StackMetadataNotFoundError", () => Effect.void)),
        };
      }),
    );
}
