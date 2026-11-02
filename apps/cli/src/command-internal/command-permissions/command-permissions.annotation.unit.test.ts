import { Effect, Layer, Option } from "effect";
import { Command } from "effect/cli";
import { describe, expect, it } from "vitest";

import { findCommand } from "../../shared/cli/command-docs.ts";
import { readPermissions, withPermissions } from "./command-permissions.annotation.ts";
import { block, compose, withCondition } from "./model.ts";

describe("withPermissions", () => {
  const dbConfig = block(
    "db-config",
    [
      { operationId: "v1-create-login-role", kind: "required" },
      {
        operationId: "v1-get-pooler-config",
        kind: "best-effort",
        when: [{ flag: "local", present: false }],
      },
    ],
    ["password"],
  );
  const linkedProjectCache = block("linked-project-cache", [
    { operationId: "v1-get-project", kind: "best-effort" },
  ]);

  const leaf = Command.make("query", {}, () => Effect.void).pipe(
    withPermissions(
      compose(
        { operations: [{ operationId: "v1-run-a-query", kind: "required" }] },
        withCondition(dbConfig, { flag: "linked" }),
        linkedProjectCache,
      ),
    ),
    Command.withDescription("Run a query"),
    Command.withHandler(() => Effect.void),
    Command.provide(Layer.empty),
    Command.withGlobalFlags([]),
  );
  const root = Command.make("supabase").pipe(
    Command.withSubcommands([Command.make("db").pipe(Command.withSubcommands([leaf]))]),
  );

  it("stores a composed declaration on the command, intact through later combinators", () => {
    const command = findCommand(root, ["db", "query"]);
    expect(command).toBeDefined();
    expect(Option.getOrUndefined(readPermissions(command!))).toEqual({
      status: "mapped",
      operations: [
        { operationId: "v1-run-a-query", kind: "required" },
        {
          operationId: "v1-create-login-role",
          kind: "required",
          when: [{ flag: "linked" }],
          source: "db-config",
        },
        {
          operationId: "v1-get-pooler-config",
          kind: "best-effort",
          when: [{ flag: "linked" }, { flag: "local", present: false, source: "db-config" }],
          source: "db-config",
        },
        { operationId: "v1-get-project", kind: "best-effort", source: "linked-project-cache" },
      ],
      noApiEffectFlags: ["password"],
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

  it("reads no declaration from a command without one", () => {
    expect(Option.isNone(readPermissions(Command.make("bare")))).toBe(true);
  });
});
