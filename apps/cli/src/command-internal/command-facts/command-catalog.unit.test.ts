import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";

import { rootCommand } from "../../cli/root.ts";
import { annotationIds, commandCatalog } from "./command-catalog.ts";
import { COMMAND_FACTS, NON_FACT_ANNOTATIONS } from "./command-facts.registry.ts";

describe("commandCatalog", () => {
  it("registers every annotation key found on the command tree", () => {
    const registered = new Set(COMMAND_FACTS.map((fact) => fact.id));
    const unregistered = [...annotationIds(rootCommand)].filter(
      (id) => !registered.has(id) && !NON_FACT_ANNOTATIONS.has(id),
    );
    expect(unregistered).toEqual([]);
  });

  it.effect(
    "describes branches delete with its output schema and declared global flags",
    () =>
      Effect.gen(function* () {
        const catalog = yield* commandCatalog(rootCommand);
        const entry = catalog.find((e) => e.path.join(" ") === "branches delete");

        expect(entry?.globalFlags).toEqual([
          "debug",
          "dns-resolver",
          "output",
          "profile",
          "workdir",
          "yes",
        ]);
        expect(entry?.facts["supabase/TargetPolicyAnnotation"]).toEqual({
          checked: ["runtime", "compiler"],
          value: { group: "hosted", consent: "no" },
        });
        expect(entry?.facts["supabase/OutputSchema"]?.value).toMatchObject({
          schema: {
            type: "object",
            required: ["project_ref", "message"],
            properties: {
              project_ref: { type: "string", description: "Project ref of the deleted branch." },
              message: { type: "string", enum: ["Deleted preview branch"] },
            },
          },
        });
      }),
  );

  it.effect("leaves facts undefined on commands that haven't adopted them", () =>
    Effect.gen(function* () {
      const catalog = yield* commandCatalog(rootCommand);
      const entry = catalog.find((e) => e.path.join(" ") === "branches list");

      expect(entry?.facts["supabase/OutputSchema"]).toBeUndefined();
      expect(entry?.globalFlags).toBeUndefined();
    }),
  );
});
