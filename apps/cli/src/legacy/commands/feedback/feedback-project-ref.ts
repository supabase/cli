import { Effect, FileSystem, Option, Path } from "effect";
import { PROJECT_REF_PATTERN } from "../../config/legacy-project-ref.service.ts";
import { legacyReadProjectRefFile } from "../../shared/legacy-temp-paths.ts";

// Mirrors the soft-load half of `LegacyProjectRefResolver.resolveOptional`
// (`legacy-project-ref.layer.ts`): the caller-supplied override (`--project-ref`
// and/or `SUPABASE_PROJECT_ID`, captured by `LegacyCliSettings`) →
// `<workdir>/supabase/.temp/project-ref`, the file `supabase link` writes. The
// file is read directly rather than via the full resolver because that layer
// requires `LegacyPlatformApiFactory` for its prompt path, and feedback must
// keep working when the user isn't logged in. A broken ref file degrades to
// "unlinked" instead of failing the command.
//
// Every candidate is filtered through `PROJECT_REF_PATTERN` — the same
// validation boundary `legacyResolveSoftLinkedRef` applies (`legacy-linked-state.ts`).
// The workdir can be an untrusted checkout where `.temp/project-ref` is a
// symlink to a local secret; anything that isn't a well-formed ref is
// discarded as "unlinked" rather than sent to the feedback backend.
export const legacyResolveFeedbackProjectRef = Effect.fnUntraced(function* (
  workdir: string,
  fromEnv: Option.Option<string>,
) {
  const validated = Option.filter(fromEnv, (ref) => PROJECT_REF_PATTERN.test(ref));
  if (Option.isSome(validated)) return validated;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  return yield* legacyReadProjectRefFile(fs, path, workdir).pipe(
    Effect.orElseSucceed(() => Option.none<string>()),
    Effect.map(Option.filter((ref) => PROJECT_REF_PATTERN.test(ref))),
  );
});
