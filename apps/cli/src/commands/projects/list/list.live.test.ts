import { Effect, Schema } from "effect";
import { expect } from "vitest";

import { test } from "../../../../tests/helpers/live.ts";

// Rows stay `Unknown`: the assertion below only needs a ref-shaped field, and the envelope
// carries whatever the platform returns for each project.
const ProjectsListEnvelope = Schema.Struct({ projects: Schema.Array(Schema.Unknown) });

test("lists the live project for the authenticated token", ({ cliEffect, project, signal }) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const result = yield* cliEffect(["projects", "list", "--output-format", "json"]);
      expect(result.exitCode, result.stderr).toBe(0);
      const parsed = yield* Schema.decodeEffect(Schema.fromJsonString(ProjectsListEnvelope))(
        result.stdout,
      );
      const refs = parsed.projects.flatMap((entry) => {
        if (entry === null || typeof entry !== "object") return [];
        if ("ref" in entry && typeof entry.ref === "string") return [entry.ref];
        if ("id" in entry && typeof entry.id === "string") return [entry.id];
        return [];
      });
      expect(refs).toContain(project.ref);
    }),
    { signal },
  ));
