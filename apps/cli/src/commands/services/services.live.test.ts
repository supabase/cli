import { expect } from "vitest";
import { Effect, Schema } from "effect";

import { requireLiveSuccess, test } from "../../../tests/helpers/live.ts";

const ServiceRows = Schema.Array(
  Schema.Struct({
    name: Schema.String,
    local: Schema.String,
    remote: Schema.String,
  }),
);

test("merges remote versions from the linked live project into services output", ({
  cliEffect,
  project,
  signal,
}) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const linked = yield* cliEffect(["link", "--project-ref", project.ref, "--skip-pooler"]);
      requireLiveSuccess(linked, "link setup for services");

      // One remote-backed invocation is the live golden path; formats are integration-tested.
      const json = yield* cliEffect(["services", "-o", "json"]);
      expect(json.exitCode, json.stderr).toBe(0);
      const rows = yield* Schema.decodeEffect(Schema.fromJsonString(ServiceRows))(json.stdout);
      expect(rows, json.stdout).toHaveLength(10);
      const postgres = rows.find((row) => row.name === "supabase/postgres");
      if (postgres === undefined) {
        throw new Error(`supabase/postgres row missing from services json:\n${json.stdout}`);
      }
      expect(postgres.remote.length, json.stdout).toBeGreaterThan(0);
    }),
    { signal },
  ));
