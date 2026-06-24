import { Data, Effect, FileSystem, Path } from "effect";
import { resolveSupabaseHome } from "../../shared/config/supabase-home.ts";

/**
 * Helpers for the persisted profile-name file under the global Supabase home,
 * mirroring Go's `getProfileName` file fallback and `SaveProfileName`
 * (`apps/cli-go/internal/utils/profile.go:121-152`).
 *
 * `login` writes this file (on success, when a profile was explicitly set) so a
 * later command run without `--profile` / `SUPABASE_PROFILE` resolves the same
 * profile; `LegacyCliConfig` reads it as the lowest-precedence profile source.
 */

/**
 * Resolves the global Supabase home for the legacy shell. Delegates to the
 * shared `resolveSupabaseHome` contract (honors `SUPABASE_HOME`, else
 * `<homeDir>/.supabase`). The legacy shell reads ambient `process.env` directly,
 * matching Go parity, so `env` defaults to it.
 */
export function legacySupabaseHome(
  homeDir: string,
  env: Readonly<Record<string, string | undefined>> = process.env,
): string {
  return resolveSupabaseHome(env, homeDir);
}

/** Raised when persisting the profile name fails — Go's `SaveProfileName` error,
 * which `login`'s PostRunE returns to block subsequent CI commands
 * (`apps/cli-go/cmd/login.go:42-46`). */
export class LegacyProfileSaveError extends Data.TaggedError("LegacyProfileSaveError")<{
  readonly message: string;
}> {}

export function legacyProfileFilePath(
  path: Path.Path,
  homeDir: string,
  env?: Readonly<Record<string, string | undefined>>,
): string {
  return path.join(legacySupabaseHome(homeDir, env), "profile");
}

/** Writes the profile name to `<SUPABASE_HOME or ~/.supabase>/profile`. Fatal on failure (Go parity). */
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
