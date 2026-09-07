import { Effect, FileSystem, Layer, Option, Schema } from "effect";
import {
  InvalidLocalServiceVersionsStateError,
  LocalServiceVersionsStateSchema,
  type LocalServiceVersionsState,
  CliProjectLocalServiceVersions,
} from "./cli-project-local-service-versions.service.ts";
import { CliProjectHome } from "./cli-project-home.service.ts";

const LocalServiceVersionsStateFileSchema = Schema.fromJsonString(LocalServiceVersionsStateSchema);
const decodeLocalServiceVersionsState = Schema.decodeUnknownEffect(
  LocalServiceVersionsStateFileSchema,
);

const makeCliProjectLocalServiceVersions = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const cliProjectHome = yield* CliProjectHome;

  const loadFromPath = (filePath: string) =>
    Effect.gen(function* () {
      // A FILE named `.supabase` reads as "no saved local versions" rather
      // than a defect (same bug family as the boot fix; reachable via `supabase services`).
      const exists = yield* fs.exists(filePath).pipe(Effect.orElseSucceed(() => false));
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
    return yield* loadFromPath(cliProjectHome.projectLocalVersionsPath);
  });

  return CliProjectLocalServiceVersions.of({
    load,
  });
});

export const cliProjectLocalServiceVersionsLayer = Layer.effect(
  CliProjectLocalServiceVersions,
  makeCliProjectLocalServiceVersions,
);
