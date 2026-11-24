import { Effect } from "effect";

import { requireTargetMutationConsent } from "../../../../../command-internal/hosted-consent/hosted-consent.ts";
import type { SparkTargetFlagValues } from "../../spark.flags.ts";
import { Output } from "../../../../../shared/output/output.service.ts";
import { applyMigrations, planPendingMigrations } from "../../spark-apply.ts";
import { requireNoPendingReset } from "../../spark-dev-instance.ts";
import { withSparkTarget } from "../../spark-target.ts";

/** `supabase db push`: the pending migrations are dry-run together on Spark, then applied in order. */
export const sparkDbPush = Effect.fn("spark.db.push")(function* (flags: SparkTargetFlagValues) {
  yield* withSparkTarget(flags, (project) =>
    Effect.gen(function* () {
      const output = yield* Output;
      if (project.kind === "dev-instance") yield* requireNoPendingReset(project.state);
      const files = yield* planPendingMigrations();
      if (files.length === 0) return yield* output.raw("Remote database is up to date.\n");
      // The checkout's own dev instance needs no consent; a linked project does.
      if (project.kind === "linked")
        yield* requireTargetMutationConsent(project, {
          action: "Push migrations",
          details: [`Apply these migrations:\n${files.map((m) => ` • ${m.file}`).join("\n")}`],
        });
      yield* applyMigrations(files);
      yield* output.raw("Finished supabase db push.\n");
    }),
  );
});
