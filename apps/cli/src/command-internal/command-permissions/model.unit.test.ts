import { describe, expect, it } from "vitest";

import { block, compose, mapped, withCondition } from "./model.ts";
import type { PermissionFragment } from "./model.ts";

describe("command-permissions model helpers", () => {
  const secretsReadFragment: PermissionFragment = {
    operations: [{ operationId: "v1-list-all-secrets", kind: "required" }],
  };
  const linkedProjectCacheFragment: PermissionFragment = {
    operations: [
      { operationId: "v1-get-project", kind: "best-effort", note: "linked-project cache" },
    ],
    noApiEffectFlags: ["debug"],
  };

  it("compose merges operations and noApiEffectFlags across fragments, preserving order", () => {
    const composed = compose(secretsReadFragment, linkedProjectCacheFragment);
    expect(composed.operations.map((entry) => entry.operationId)).toEqual([
      "v1-list-all-secrets",
      "v1-get-project",
    ]);
    expect(composed.noApiEffectFlags).toEqual(["debug"]);
  });

  it("compose on zero fragments produces an empty fragment", () => {
    expect(compose()).toEqual({ operations: [], noApiEffectFlags: [] });
  });

  it("withCondition prepends the condition to every entry's own when clause", () => {
    const conditioned = withCondition(linkedProjectCacheFragment, { flag: "linked" });
    expect(conditioned.operations).toEqual([
      {
        operationId: "v1-get-project",
        kind: "best-effort",
        note: "linked-project cache",
        when: [{ flag: "linked" }],
      },
    ]);
    // The source fragment is untouched.
    expect(linkedProjectCacheFragment.operations[0]!.when).toBeUndefined();
  });

  it("withCondition keeps an entry's own when conditions after the new one", () => {
    const fragment: PermissionFragment = {
      operations: [
        {
          operationId: "v1-run-a-query",
          kind: "required",
          when: [{ flag: "local", present: false }],
        },
      ],
    };
    const conditioned = withCondition(fragment, { flag: "linked" });
    expect(conditioned.operations[0]!.when).toEqual([
      { flag: "linked" },
      { flag: "local", present: false },
    ]);
  });

  it("block tags every entry with its source, without mutating the caller's input", () => {
    const entries = [
      { operationId: "v1-create-login-role", kind: "required" as const },
      {
        operationId: "v1-get-pooler-config",
        kind: "best-effort" as const,
        when: [{ flag: "local", present: false }],
      },
    ];
    const dbConfig = block("db-config", entries, ["db-url", "password"]);
    expect(dbConfig.operations).toEqual([
      { operationId: "v1-create-login-role", kind: "required", source: "db-config" },
      {
        operationId: "v1-get-pooler-config",
        kind: "best-effort",
        when: [{ flag: "local", present: false }],
        source: "db-config",
      },
    ]);
    expect(dbConfig.noApiEffectFlags).toEqual(["db-url", "password"]);
    expect(entries[0]).not.toHaveProperty("source");
  });

  it("mapped turns a fragment into a CommandPermissions with an empty noApiEffectFlags default", () => {
    expect(mapped(secretsReadFragment)).toEqual({
      status: "mapped",
      operations: secretsReadFragment.operations,
      noApiEffectFlags: [],
    });
    expect(mapped(linkedProjectCacheFragment)).toEqual({
      status: "mapped",
      operations: linkedProjectCacheFragment.operations,
      noApiEffectFlags: ["debug"],
    });
  });
});
