import { V1GetProjectApiKeysOutput } from "@supabase/api/effect";
import { Effect, Schema } from "effect";
import { expect } from "vitest";

import { test } from "../../../../tests/helpers/live.ts";

test("lists API keys for a project", ({ cliEffect, project, signal }) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const result = yield* cliEffect([
        "projects",
        "api-keys",
        "--project-ref",
        project.ref,
        "--output",
        "json",
      ]);
      expect(result.exitCode, result.stderr).toBe(0);
      const rows = yield* Schema.decodeEffect(Schema.fromJsonString(V1GetProjectApiKeysOutput))(
        result.stdout,
      );
      expect(
        rows.some((key) => key.name === "anon" || key.api_key?.startsWith("sb_publishable_")),
      ).toBe(true);
    }),
    { signal },
  ));
