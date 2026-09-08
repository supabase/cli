import { Effect, FileSystem, Option, Path } from "effect";
import { PROJECT_REF_PATTERN } from "../../config/project-ref.service.ts";
import { readProjectRefFile } from "../../command-internal/temp-paths.ts";

// Mirrors the soft-load half of `ProjectRefResolver.resolveOptional`
// (`project-ref.layer.ts`): the caller-supplied override (`--project-ref`
// and/or `SUPABASE_PROJECT_ID`, captured by `CommandSettings`) →
// `<workdir>/supabase/.temp/project-ref`, the file `supabase link` writes. The
// file is read directly rather than via the full resolver because that layer
// requires `CommandPlatformApiFactory` for its prompt path, and feedback must
// keep working when the user isn't logged in. A broken ref file degrades to
// "unlinked" instead of failing the command.
//
// Every candidate is filtered through `PROJECT_REF_PATTERN` — the same
// validation boundary the linked-ref resolvers apply. The workdir can be an
// untrusted checkout where `.temp/project-ref` is a symlink to a local
// secret; anything that isn't a well-formed ref is discarded as "unlinked"
// rather than sent to the feedback backend.
export const resolveFeedbackProjectRef = Effect.fnUntraced(function* (
  workdir: string,
  fromEnv: Option.Option<string>,
) {
  const validated = Option.filter(fromEnv, (ref) => PROJECT_REF_PATTERN.test(ref));
  if (Option.isSome(validated)) return validated;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  return yield* readProjectRefFile(fs, path, workdir).pipe(
    Effect.orElseSucceed(() => Option.none<string>()),
    Effect.map(Option.filter((ref) => PROJECT_REF_PATTERN.test(ref))),
  );
});
