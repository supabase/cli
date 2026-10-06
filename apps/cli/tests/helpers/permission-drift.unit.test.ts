import { describe, expect, it } from "vitest";

import type { CommandPermissions } from "../../src/command-internal/command-permissions/model.ts";
import type { DeclaredPermissionsLookup } from "../../src/command-internal/command-permissions/registry.ts";
import { assertDriftAgainst } from "./permission-drift.ts";
import { OPERATIONS } from "./operation-table.ts";

const REF = "abcdefghijklmnopqrst";
const API = "https://api.supabase.com";

const listSecrets = { method: "GET", url: `${API}/v1/projects/${REF}/secrets` };
const runQuery = { method: "POST", url: `${API}/v1/projects/${REF}/database/query` };
const getProject = { method: "GET", url: `${API}/v1/projects/${REF}` };

function declared(permissions: CommandPermissions): DeclaredPermissionsLookup {
  return { _tag: "Declared", permissions };
}

const mappedCommand = declared({
  status: "mapped",
  operations: [
    { operationId: "v1-list-all-secrets", kind: "required" },
    { operationId: "v1-run-a-query", kind: "required", when: [{ flag: "linked" }] },
  ],
  noApiEffectFlags: ["project-ref"],
});

describe("assertDriftAgainst", () => {
  it("resolves the sample requests to the operations the declaration names", () => {
    const resolved = (request: { method: string; url: string }) =>
      [...OPERATIONS.values()].find(
        (operation) =>
          operation.method === request.method &&
          operation.pathTemplate.replace("{ref}", REF) === new URL(request.url).pathname,
      )?.operationId;
    expect(resolved(listSecrets)).toBe("v1-list-all-secrets");
    expect(resolved(runQuery)).toBe("v1-run-a-query");
    expect(resolved(getProject)).toBe("v1-get-project");
  });

  it("passes when every request is a declared operation whose condition holds", () => {
    expect(() =>
      assertDriftAgainst(mappedCommand, {
        command: "secrets list",
        activeFlags: ["linked"],
        requests: [listSecrets, runQuery],
        exact: true,
      }),
    ).not.toThrow();
  });

  it("ignores a request that is not a Management API call", () => {
    expect(() =>
      assertDriftAgainst(mappedCommand, {
        command: "secrets list",
        requests: [
          listSecrets,
          { method: "GET", url: "https://registry.example.com/v2/org/image/manifests/latest" },
        ],
      }),
    ).not.toThrow();
  });

  it("rejects a command path missing from the tree, naming the variant", () => {
    expect(() =>
      assertDriftAgainst(
        { _tag: "NotFound" },
        { command: "compute list", requests: [], variant: undefined },
      ),
    ).toThrow(/"compute list" is not in the "default" command tree/);
  });

  it("rejects a command with no declaration", () => {
    expect(() =>
      assertDriftAgainst({ _tag: "Undeclared" }, { command: "secrets list", requests: [] }),
    ).toThrow(/no permission mapping declared for command "secrets list"/);
  });

  it("rejects a command declared unmapped, which makes no claims to check", () => {
    expect(() =>
      assertDriftAgainst(declared({ status: "unmapped", reason: "go-delegated" }), {
        command: "gen keys",
        requests: [],
      }),
    ).toThrow(/declared unmapped \(go-delegated\)/);
  });

  it("rejects an active flag the declaration never classifies", () => {
    expect(() =>
      assertDriftAgainst(mappedCommand, {
        command: "secrets list",
        activeFlags: ["lnked"],
        requests: [],
      }),
    ).toThrow(/activeFlags names "lnked"/);
  });

  it("rejects an in-scope request that matches no known operation", () => {
    expect(() =>
      assertDriftAgainst(mappedCommand, {
        command: "secrets list",
        requests: [{ method: "GET", url: `${API}/v1/not-a-real-route` }],
      }),
    ).toThrow(/matched no known Management API operation/);
  });

  it("rejects a request to an operation the command does not declare", () => {
    expect(() =>
      assertDriftAgainst(mappedCommand, { command: "secrets list", requests: [getProject] }),
    ).toThrow(/"v1-get-project", which is not declared for this command at all/);
  });

  it("rejects a declared operation whose condition does not hold for the active flags", () => {
    expect(() =>
      assertDriftAgainst(mappedCommand, {
        command: "secrets list",
        activeFlags: [],
        requests: [runQuery],
      }),
    ).toThrow(/"v1-run-a-query", which is declared for this command but whose `when` condition/);
  });

  it("resolves requests against a custom API URL", () => {
    expect(() =>
      assertDriftAgainst(mappedCommand, {
        command: "secrets list",
        apiUrl: "http://localhost:54321",
        requests: [{ method: "GET", url: `http://localhost:54321/v1/projects/${REF}/secrets` }],
        exact: true,
      }),
    ).not.toThrow();
  });

  describe("exact", () => {
    it("rejects a required operation that applies but was never requested", () => {
      expect(() =>
        assertDriftAgainst(mappedCommand, {
          command: "secrets list",
          activeFlags: ["linked"],
          requests: [listSecrets],
          exact: true,
        }),
      ).toThrow(/expected these required operations to be requested but none were: v1-run-a-query/);
    });

    it("does not require an operation whose condition does not hold", () => {
      expect(() =>
        assertDriftAgainst(mappedCommand, {
          command: "secrets list",
          activeFlags: [],
          requests: [listSecrets],
          exact: true,
        }),
      ).not.toThrow();
    });

    it("does not require best-effort entries or entries with a context", () => {
      const lookup = declared({
        status: "mapped",
        operations: [
          { operationId: "v1-list-all-secrets", kind: "required" },
          { operationId: "v1-get-project", kind: "best-effort" },
          { operationId: "v1-run-a-query", kind: "required", context: "only on a cache miss" },
        ],
        noApiEffectFlags: [],
      });
      expect(() =>
        assertDriftAgainst(lookup, {
          command: "secrets list",
          requests: [listSecrets],
          exact: true,
        }),
      ).not.toThrow();
    });
  });
});
