import { Effect, FileSystem, Option, Path } from "effect";
import { legacyReadProjectRefFile } from "../../shared/legacy-temp-paths.ts";

// Mirrors the soft-load half of `LegacyProjectRefResolver.resolveOptional`
// (`legacy-project-ref.layer.ts`): the caller-supplied override (`--project-ref`
// and/or `SUPABASE_PROJECT_ID`, captured by `LegacyCliConfig`) →
// `<workdir>/supabase/.temp/project-ref`, the file `supabase link` writes. The
// file is read directly rather than via the full resolver because that layer
// requires `LegacyPlatformApiFactory` for its prompt path, and feedback must
// keep working when the user isn't logged in. A broken ref file degrades to
// "unlinked" instead of failing the command.
export const legacyResolveFeedbackProjectRef = Effect.fnUntraced(function* (
  workdir: string,
  fromEnv: Option.Option<string>,
) {
  if (Option.isSome(fromEnv)) return fromEnv;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  return yield* legacyReadProjectRefFile(fs, path, workdir).pipe(
    Effect.orElseSucceed(() => Option.none<string>()),
  );
});
