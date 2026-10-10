import { Effect, Layer, Option } from "effect";
import { Command } from "effect/unstable/cli";
import { describe, expect, it } from "vitest";

import { readPermissions, withPermissions } from "./command-permissions.annotation.ts";
import { findCommand } from "../../shared/cli/command-docs.ts";
import { applicableOperations, declaredPermissions } from "./registry.ts";
import { block } from "./model.ts";
import type { CommandPermissions } from "./model.ts";

describe("applicableOperations", () => {
  const mapped = (
    operations: Extract<CommandPermissions, { status: "mapped" }>["operations"],
  ): Extract<CommandPermissions, { status: "mapped" }> => ({
    status: "mapped",
    operations,
    noApiEffectFlags: [],
  });

  it("drops entries whose when condition doesn't hold for the given activeFlags", () => {
    const permissions = mapped([
      { operationId: "v1-run-a-query", kind: "required", when: [{ flag: "linked" }] },
      { operationId: "v1-list-all-secrets", kind: "required" },
    ]);
    expect(applicableOperations(permissions, []).map((e) => e.operationId)).toEqual([
      "v1-list-all-secrets",
    ]);
    expect(applicableOperations(permissions, ["linked"]).map((e) => e.operationId)).toEqual([
      "v1-run-a-query",
      "v1-list-all-secrets",
    ]);
  });

  it("keeps a required entry with no context over a required entry that has one, for the same operationId", () => {
    const permissions = mapped([
      {
        operationId: "v1-get-project",
        kind: "required",
        context: "only on a cache miss",
        source: "linked-project-cache",
      },
      { operationId: "v1-get-project", kind: "required" },
    ]);
    const result = applicableOperations(permissions, []);
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({ operationId: "v1-get-project", kind: "required" });
  });

  it("keeps a required entry over a best-effort entry for the same operationId, regardless of order", () => {
    const bestEffortFirst = mapped([
      { operationId: "v1-get-project", kind: "best-effort", source: "linked-project-cache" },
      { operationId: "v1-get-project", kind: "required" },
    ]);
    const requiredFirst = mapped([
      { operationId: "v1-get-project", kind: "required" },
      { operationId: "v1-get-project", kind: "best-effort", source: "linked-project-cache" },
    ]);
    expect(applicableOperations(bestEffortFirst, [])).toEqual([
      { operationId: "v1-get-project", kind: "required" },
    ]);
    expect(applicableOperations(requiredFirst, [])).toEqual([
      { operationId: "v1-get-project", kind: "required" },
    ]);
  });
});

describe("withPermissions", () => {
  const listSecrets = block("test", [{ operationId: "v1-list-all-secrets", kind: "required" }]);

  const leaf = Command.make("list", {}, () => Effect.void).pipe(
    withPermissions(listSecrets),
    Command.withDescription("List secrets"),
    Command.withHandler(() => Effect.void),
    Command.provide(Layer.empty),
    Command.withGlobalFlags([]),
  );
  const root = Command.make("supabase").pipe(
    Command.withSubcommands([Command.make("secrets").pipe(Command.withSubcommands([leaf]))]),
  );

  it("stores a fragment as a mapped declaration that survives later combinators", () => {
    const command = findCommand(root, ["secrets", "list"]);
    expect(command).toBeDefined();
    expect(Option.getOrUndefined(readPermissions(command!))).toEqual({
      status: "mapped",
      operations: [{ operationId: "v1-list-all-secrets", kind: "required", source: "test" }],
      noApiEffectFlags: [],
    });
  });

  it("stores an unmapped declaration as given", () => {
    const delegated = Command.make("create").pipe(
      withPermissions({ status: "unmapped", reason: "go-delegated" }),
    );
    expect(Option.getOrUndefined(readPermissions(delegated))).toEqual({
      status: "unmapped",
      reason: "go-delegated",
    });
  });

  it("reads no declaration from a command without one, and from a path that does not exist", () => {
    expect(Option.isNone(readPermissions(Command.make("bare")))).toBe(true);
    expect(findCommand(root, ["secrets", "nope"])).toBeUndefined();
  });
});

describe("declaredPermissions", () => {
  it("tells a path missing from the tree apart from a command with no declaration", () => {
    expect(declaredPermissions("not-a-real-command")).toEqual({ _tag: "NotFound" });
    expect(declaredPermissions("compute list")).toEqual({ _tag: "NotFound" });
    expect(declaredPermissions("compute list", { computeEnabled: true })).toEqual({
      _tag: "Undeclared",
    });
  });
});
