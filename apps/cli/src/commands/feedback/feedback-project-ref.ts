import { Effect, FileSystem, Option, Path } from "effect";
import { InvalidProjectRefError } from "../../config/project-ref.errors.ts";
import {
  INVALID_PROJECT_REF_MESSAGE,
  PROJECT_REF_PATTERN,
} from "../../config/project-ref.service.ts";
import { readProjectRefFile } from "../../command-internal/temp-paths.ts";

// Mirrors `ProjectRefResolver` (`project-ref.layer.ts`) source by source:
//
// - The caller-supplied override (`--project-ref` and/or `SUPABASE_PROJECT_ID`,
//   captured by `CommandSettings`) is validated against `PROJECT_REF_PATTERN`
//   and fails with the shared `InvalidProjectRefError` when malformed — the
//   same hard check every `resolve`/`loadProjectRef` caller applies to a value
//   the user typed, so a typo is reported instead of silently falling through
//   to a different project's context.
// - `<workdir>/supabase/.temp/project-ref`, the file `supabase link` writes, is
//   the soft half (`resolveOptional`): read directly rather than via the full
//   resolver because that layer requires `CommandPlatformApiFactory` for its
//   prompt path, and feedback must keep working when the user isn't logged in.
//   A broken or malformed ref file degrades to "unlinked" instead of failing
//   the command — the workdir can be an untrusted checkout where the file is a
//   symlink to a local secret, and anything that isn't a well-formed ref is
//   discarded rather than sent to the feedback backend.
export const resolveFeedbackProjectRef = Effect.fnUntraced(function* (
  workdir: string,
  override: Option.Option<string>,
) {
  if (Option.isSome(override)) {
    if (!PROJECT_REF_PATTERN.test(override.value)) {
      return yield* Effect.fail(
        new InvalidProjectRefError({ ref: override.value, message: INVALID_PROJECT_REF_MESSAGE }),
      );
    }
    return override;
  }
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  return yield* readProjectRefFile(fs, path, workdir).pipe(
    Effect.orElseSucceed(() => Option.none<string>()),
    Effect.map(Option.filter((ref) => PROJECT_REF_PATTERN.test(ref))),
  );
});
