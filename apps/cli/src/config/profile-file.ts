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

/**
 * Resolves the global Supabase home for the CLI. Delegates to the
 * shared `resolveSupabaseHome` contract (honors `SUPABASE_HOME`, else
 * `<homeDir>/.supabase`). The CLI reads ambient `process.env`
 * directly, so `env` defaults to it.
 */
export function supabaseHome(
  homeDir: string,
  env: Readonly<Record<string, string | undefined>> = process.env,
): string {
  return resolveSupabaseHome(env, homeDir);
}

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
  return path.join(supabaseHome(homeDir, env), "profile");
}

/** Writes the profile name to `<SUPABASE_HOME or ~/.supabase>/profile`. Fatal on failure. */
export const saveProfileName = (
  fs: FileSystem.FileSystem,
  path: Path.Path,
  homeDir: string,
  name: string,
): Effect.Effect<void, ProfileSaveError> =>
  Effect.gen(function* () {
    const filePath = profileFilePath(path, homeDir);
    yield* fs.makeDirectory(path.dirname(filePath), { recursive: true });
    yield* fs.writeFileString(filePath, name);
  }).pipe(
    Effect.catch((error) =>
      Effect.fail(new ProfileSaveError({ message: `failed to save profile: ${error.message}` })),
    ),
  );
