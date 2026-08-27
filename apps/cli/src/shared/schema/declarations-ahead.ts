import { Effect } from "effect";
import { SchemaDeclarationsAheadError } from "./schema-errors.ts";
import { SchemaStateStore } from "./schema-state.service.ts";

export const assertNoUngeneratedDraft = Effect.fnUntraced(function* () {
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
        "Run `supabase schema generate --name <feature>`, reset the local database, or discard the draft before `supabase migrations push`.",
    });
  }
});
