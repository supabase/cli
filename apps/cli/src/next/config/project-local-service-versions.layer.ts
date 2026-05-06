import { Effect, FileSystem, Layer, Option, Schema } from "effect";
import {
  InvalidLocalServiceVersionsStateError,
  LocalServiceVersionsStateSchema,
  type LocalServiceVersionsState,
  ProjectLocalServiceVersions,
} from "./project-local-service-versions.service.ts";
import { ProjectHome } from "./project-home.service.ts";

const LocalServiceVersionsStateFileSchema = Schema.fromJsonString(LocalServiceVersionsStateSchema);
const decodeLocalServiceVersionsState = Schema.decodeUnknownEffect(
  LocalServiceVersionsStateFileSchema,
);

const makeProjectLocalServiceVersions = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const projectHome = yield* ProjectHome;

  const loadFromPath = (filePath: string) =>
    Effect.gen(function* () {
      const exists = yield* fs.exists(filePath).pipe(Effect.orDie);
      if (!exists) {
        return Option.none<LocalServiceVersionsState>();
      }

      const content = yield* fs.readFileString(filePath).pipe(Effect.orDie);
      const decoded = yield* decodeLocalServiceVersionsState(content).pipe(
        Effect.mapError(
          () =>
            new InvalidLocalServiceVersionsStateError({
              detail: `The local service override file at ${filePath} is invalid.`,
              suggestion: "Fix or remove local-versions.json, then retry `supabase start`.",
            }),
        ),
      );
      return Option.some(decoded);
    });

  const load = Effect.gen(function* () {
    return yield* loadFromPath(projectHome.projectLocalVersionsPath);
  });

  return ProjectLocalServiceVersions.of({
    load,
  });
});

export const projectLocalServiceVersionsLayer = Layer.effect(
  ProjectLocalServiceVersions,
  makeProjectLocalServiceVersions,
);
