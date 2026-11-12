import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";

import { rootCommand } from "../../cli/root.ts";
import { annotationIds, commandCatalog } from "./command-catalog.ts";
import { COMMAND_FACTS, NON_FACT_ANNOTATIONS } from "./command-facts.registry.ts";

const entryAt = (path: string) =>
  commandCatalog(rootCommand).pipe(
    Effect.map((catalog) => catalog.find((entry) => entry.path.join(" ") === path)),
  );

describe("commandCatalog", () => {
  it("registers every annotation key found on the command tree", () => {
    const ids = annotationIds(rootCommand);
    expect(ids).toContain("supabase/CommandPermissions");
    expect(ids).toContain("supabase/TargetPolicyAnnotation");

    const registered = new Set(COMMAND_FACTS.map((fact) => fact.id));
    const unregistered = [...ids].filter(
      (id) => !registered.has(id) && !NON_FACT_ANNOTATIONS.has(id),
    );
    expect(unregistered).toEqual([]);
  });

  it.effect("reports a command's registered facts with their check kinds", () =>
    Effect.gen(function* () {
      const entry = yield* entryAt("branches delete");

      expect(entry?.facts["supabase/TargetPolicyAnnotation"]).toEqual({
        checked: ["runtime", "compiler"],
        value: { group: "hosted", consent: "no" },
      });
      expect(entry?.facts["supabase/CommandPermissions"]).toMatchObject({
        checked: ["none"],
        value: {
          status: "mapped",
          operations: expect.arrayContaining([
            { operationId: "v1-delete-a-branch", kind: "required" },
          ]),
        },
      });
    }),
  );

  it.effect("reports a command's declared output schema as test-checked", () =>
    Effect.gen(function* () {
      const entry = yield* entryAt("branches delete");

      expect(entry?.facts["supabase/CommandOutput"]).toMatchObject({
        checked: ["test"],
        value: {
          schema: {
            type: "object",
            properties: { project_ref: { type: "string" } },
            required: expect.arrayContaining(["project_ref", "message"]),
          },
        },
      });
    }),
  );

  it.effect("keeps a permission entry's conditions and request details", () =>
    Effect.gen(function* () {
      const entry = yield* entryAt("projects api-keys");

      expect(entry?.facts["supabase/CommandPermissions"]?.value).toMatchObject({
        operations: expect.arrayContaining([
          expect.objectContaining({
            when: [{ flag: "reveal", is: true }],
            request: { query: { reveal: "true" } },
          }),
        ]),
      });
    }),
  );

  it.effect("reports a flag's documented default", () =>
    Effect.gen(function* () {
      const entry = yield* entryAt("db advisors");

      expect(entry?.flags.find((flag) => flag.id === "level")).toMatchObject({
        id: "level",
        default_value: "warn",
      });
    }),
  );

  it.effect("reports no facts for a command that declares none", () =>
    Effect.gen(function* () {
      const entry = yield* entryAt("branches");

      expect(entry?.facts).toEqual({});
    }),
  );
});
