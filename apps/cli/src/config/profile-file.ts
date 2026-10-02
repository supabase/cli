import { Data, Effect, FileSystem, Path } from "effect";
import { resolveSupabaseHome } from "../shared/config/supabase-home.ts";
import {
  actionability,
  type CliErrorActionabilityDeclaration,
  ErrorActionabilityId,
} from "../shared/telemetry/error-actionability.ts";

/**
 * Helpers for the persisted profile-name file under the global Supabase home.
 *
 * `login` writes this file (on success, when a profile was explicitly set) so a
 * later command run without `--profile` / `SUPABASE_PROFILE` resolves the same
 * profile; `CommandSettings` reads it as the lowest-precedence profile source.
 */

/** Raised when persisting the profile name fails — fails `login` outright,
 * blocking subsequent CI commands that rely on the persisted profile. */
export class ProfileSaveError extends Data.TaggedError("ProfileSaveError")<{
  readonly message: string;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return actionability.permission;
  }
}

export function profileFilePath(
  path: Path.Path,
  homeDir: string,
  env?: Readonly<Record<string, string | undefined>>,
): string {
  return path.join(resolveSupabaseHome(path, env ?? process.env, homeDir), "profile");
}

/** Writes the profile name to the resolved profile path. Fatal on failure. */
export const saveProfileName = (
  fs: FileSystem.FileSystem,
  path: Path.Path,
  profilePath: string,
  name: string,
): Effect.Effect<void, ProfileSaveError> =>
  Effect.gen(function* () {
    yield* fs.makeDirectory(path.dirname(profilePath), { recursive: true });
    yield* fs.writeFileString(profilePath, name);
  }).pipe(
    Effect.mapError(
      (error) => new ProfileSaveError({ message: `failed to save profile: ${error.message}` }),
    ),
  );
