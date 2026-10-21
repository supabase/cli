import { operationPermissions } from "@supabase/api/permissions";
import { Exit, Option } from "effect";
import { describe, expect, it } from "vitest";

import { commandTreeFor } from "../../../tests/helpers/command-flags.ts";
import type { PermissionVariant } from "../../../tests/helpers/permission-registry.ts";
import { readPermissions } from "./command-permissions.annotation.ts";
import { fgaRequestSets, fgaSetForQuery } from "./fga-request-sets.ts";

const VARIANTS: ReadonlyArray<PermissionVariant> = [
  undefined,
  {
    projectState: Exit.succeed("stack"),
    stackBackend: "stack",
    computeEnabled: true,
  } satisfies Required<NonNullable<PermissionVariant>>,
];

describe("FGA request sets", () => {
  it("only name permission sets the API spec lists for the operation", () => {
    for (const { operationId, permissions } of fgaRequestSets) {
      const specSets = operationPermissions[operationId]?.fga ?? [];
      expect(
        specSets.some(
          (set) => set.length === permissions.length && permissions.every((p) => set.includes(p)),
        ),
        `${operationId} spec sets do not include ${permissions.join(" + ")}`,
      ).toBe(true);
    }
  });

  it("cover every request detail a command declaration makes", () => {
    for (const variant of VARIANTS) {
      for (const [path, node] of commandTreeFor(variant)) {
        const declared = Option.getOrUndefined(readPermissions(node.command));
        if (declared?.status !== "mapped") continue;
        for (const entry of declared.operations) {
          if (entry.request?.query === undefined) continue;
          expect(
            fgaSetForQuery(entry.operationId, entry.request.query),
            `"${path}" sends ${JSON.stringify(entry.request.query)} to ${entry.operationId}`,
          ).toBeDefined();
        }
      }
    }
  });

  it("leaves a request without the detail on the operation's own sets", () => {
    expect(fgaSetForQuery("v1-get-project-api-keys", undefined)).toBeUndefined();
    expect(fgaSetForQuery("v1-get-project-api-keys", { reveal: "false" })).toBeUndefined();
  });
});
