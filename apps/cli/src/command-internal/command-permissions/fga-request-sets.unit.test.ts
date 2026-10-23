import { operationPermissions } from "@supabase/api/permissions";
import { Exit, Option } from "effect";
import { describe, expect, it } from "vitest";

import { commandTreeFor } from "../../../tests/helpers/command-flags.ts";
import type { PermissionVariant } from "../../../tests/helpers/permission-registry.ts";
import { readPermissions } from "./command-permissions.annotation.ts";
import {
  fgaConditionalExtras,
  fgaOperationNotes,
  fgaRequestSets,
  fgaResourceCases,
  fgaSetForRequest,
} from "./fga-request-sets.ts";

const VARIANTS: ReadonlyArray<PermissionVariant> = [
  undefined,
  {
    projectState: Exit.succeed("stack"),
    stackBackend: "stack",
    computeEnabled: true,
  } satisfies Required<NonNullable<PermissionVariant>>,
];

const isSpecSet = (operationId: string, permissions: ReadonlyArray<string>) =>
  (operationPermissions[operationId]?.fga ?? []).some(
    (set) => set.length === permissions.length && permissions.every((p) => set.includes(p)),
  );

const declaredOperationIds = () =>
  new Set(
    VARIANTS.flatMap((variant) =>
      [...commandTreeFor(variant).values()].flatMap((node) => {
        const declared = Option.getOrUndefined(readPermissions(node.command));
        return declared?.status === "mapped"
          ? declared.operations.map((entry) => entry.operationId)
          : [];
      }),
    ),
  );

describe("FGA request sets", () => {
  it("only name permission sets the API spec lists for the operation", () => {
    for (const { operationId, permissions } of fgaRequestSets) {
      expect(
        isSpecSet(operationId, permissions),
        `${operationId} spec sets do not include ${permissions.join(" + ")}`,
      ).toBe(true);
    }
    for (const { operationId, required, extra } of fgaConditionalExtras) {
      expect(isSpecSet(operationId, required), `${operationId} required ${required}`).toBe(true);
      expect(isSpecSet(operationId, extra), `${operationId} extra ${extra}`).toBe(true);
    }
    for (const { operationId, cases } of fgaResourceCases) {
      expect(cases.length, `${operationId} cases`).toBeGreaterThan(1);
      for (const { allOf } of cases) {
        expect(isSpecSet(operationId, allOf), `${operationId} case ${allOf}`).toBe(true);
      }
    }
  });

  it("only correct operations some command declares", () => {
    const declared = declaredOperationIds();
    const corrected = [
      ...fgaRequestSets.map((entry) => entry.operationId),
      ...fgaConditionalExtras.map((entry) => entry.operationId),
      ...fgaResourceCases.map((entry) => entry.operationId),
    ];
    for (const operationId of corrected) {
      expect(declared.has(operationId), `no command declares ${operationId}`).toBe(true);
    }
  });

  it("only add a note for an operation the API spec lists no FGA set for", () => {
    expect(fgaOperationNotes.size).toBeGreaterThan(0);
    for (const operationId of fgaOperationNotes.keys()) {
      expect(operationPermissions[operationId]?.fga, `${operationId} spec sets`).toEqual([]);
    }
  });

  it("cover every request detail a command declaration makes", () => {
    for (const variant of VARIANTS) {
      for (const [path, node] of commandTreeFor(variant)) {
        const declared = Option.getOrUndefined(readPermissions(node.command));
        if (declared?.status !== "mapped") continue;
        for (const entry of declared.operations) {
          if (entry.request === undefined) continue;
          expect(
            fgaSetForRequest(entry.operationId, entry.request),
            `"${path}" sends ${JSON.stringify(entry.request)} to ${entry.operationId}`,
          ).toBeDefined();
        }
      }
    }
  });

  it("leaves a request without the detail on the operation's own sets", () => {
    expect(fgaSetForRequest("v1-get-project-api-keys", undefined)).toBeUndefined();
    expect(
      fgaSetForRequest("v1-get-project-api-keys", { query: { reveal: "false" } }),
    ).toBeUndefined();
    expect(
      fgaSetForRequest("v1-create-a-branch", { body: { with_data: "false" } }),
    ).toBeUndefined();
    expect(
      fgaSetForRequest("v1-create-a-branch", { query: { with_data: "true" } }),
    ).toBeUndefined();
  });

  it("matches a request detail in the body", () => {
    expect(fgaSetForRequest("v1-create-a-branch", { body: { with_data: "true" } })).toEqual([
      "branching_production_create",
    ]);
  });
});
