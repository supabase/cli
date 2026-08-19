import { Effect } from "effect";
import { digestFileSet } from "./schema-digest.ts";
import { SchemaDeclarationsAheadError } from "./schema-errors.ts";
import { SchemaStateStore } from "./schema-state.service.ts";
import { SchemaWorkspace } from "./schema-workspace.service.ts";

export const assertDeclarationsNotAhead = Effect.fnUntraced(function* () {
  const workspace = yield* SchemaWorkspace;
  const state = yield* SchemaStateStore;
  const journal = yield* state.readJournal;
  if (
    journal._tag === "Some" &&
    journal.value.declarativelyAhead &&
    journal.value.generated !== true
  ) {
    return yield* new SchemaDeclarationsAheadError({
      detail: "A declarative draft is ahead of the local migration head.",
      suggestion:
        "Run `supabase schema generate --name <feature>` before `supabase migrations push`.",
    });
  }
  const declarations = yield* workspace.readDeclarationFiles;
  if (declarations.length === 0) return;
  const checkpoint = yield* state.readCheckpoint;
  const current = digestFileSet(declarations);
  if (checkpoint._tag === "None" || checkpoint.value.declarativeDigest !== current) {
    return yield* new SchemaDeclarationsAheadError({
      detail: "Declarations are ahead of the local migration head.",
      suggestion:
        "Run `supabase schema generate --name <feature>` before `supabase migrations push`.",
    });
  }
});
