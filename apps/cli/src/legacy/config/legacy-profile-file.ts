import { Data, Effect, FileSystem, Option, Path } from "effect";

/**
 * Helpers for the persisted profile-name file `~/.supabase/profile`, mirroring
 * Go's `getProfileName` file fallback and `SaveProfileName`
 * (`apps/cli-go/internal/utils/profile.go:121-152`).
 *
 * `login` writes this file (on success, when a profile was explicitly set) so a
 * later command run without `--profile` / `SUPABASE_PROFILE` resolves the same
 * profile; `LegacyCliConfig` reads it as the lowest-precedence profile source.
 */

/** Raised when persisting the profile name fails — Go's `SaveProfileName` error,
 * which `login`'s PostRunE returns to block subsequent CI commands
 * (`apps/cli-go/cmd/login.go:42-46`). */
export class LegacyProfileSaveError extends Data.TaggedError("LegacyProfileSaveError")<{
  readonly message: string;
}> {}

function legacyProfileFilePath(path: Path.Path, homeDir: string): string {
  return path.join(homeDir, ".supabase", "profile");
}

/** Reads `~/.supabase/profile`, returning `None` when missing or empty. */
export const readLegacyProfileFile = (
  fs: FileSystem.FileSystem,
  path: Path.Path,
  homeDir: string,
): Effect.Effect<Option.Option<string>> =>
  Effect.gen(function* () {
    const filePath = legacyProfileFilePath(path, homeDir);
    const content = yield* fs.readFileString(filePath).pipe(Effect.option);
    if (Option.isNone(content)) return Option.none<string>();
    const trimmed = content.value.trim();
    return trimmed.length === 0 ? Option.none<string>() : Option.some(trimmed);
  });

/** Writes the profile name to `~/.supabase/profile`. Fatal on failure (Go parity). */
export const saveLegacyProfileName = (
  fs: FileSystem.FileSystem,
  path: Path.Path,
  homeDir: string,
  name: string,
): Effect.Effect<void, LegacyProfileSaveError> =>
  Effect.gen(function* () {
    const filePath = legacyProfileFilePath(path, homeDir);
    yield* fs.makeDirectory(path.dirname(filePath), { recursive: true });
    yield* fs.writeFileString(filePath, name);
  }).pipe(
    Effect.catch((error) =>
      Effect.fail(
        new LegacyProfileSaveError({ message: `failed to save profile: ${error.message}` }),
      ),
    ),
  );
