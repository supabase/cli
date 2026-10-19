import { describe, expect, it } from "vitest";

import type { CommandPermissions } from "../../src/command-internal/command-permissions/model.ts";
import type { DeclaredPermissionsLookup } from "./permission-registry.ts";
import { block } from "../../src/command-internal/command-permissions/model.ts";
import { assertBlockDrift, assertDriftAgainst } from "./permission-drift.ts";
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
        activeFlags: { linked: true },
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
        activeFlags: { lnked: true },
        requests: [],
      }),
    ).toThrow(/activeFlags names "lnked"/);
  });

  it("rejects an active flag given no value when a condition checks its value", () => {
    const valueChecked = declared({
      status: "mapped",
      operations: [
        { operationId: "v1-list-all-secrets", kind: "required" },
        {
          operationId: "v1-run-a-query",
          kind: "required",
          when: [{ flag: "type", oneOf: ["sql"] }],
        },
      ],
      noApiEffectFlags: [],
    });
    expect(() =>
      assertDriftAgainst(valueChecked, {
        command: "secrets list",
        activeFlags: { type: true },
        requests: [listSecrets],
      }),
    ).toThrow(/gives "type" no value, but a `when` condition checks its value/);
  });

  it("rejects a switch condition whose flag is missing from activeFlags or given a non-boolean", () => {
    const switchChecked = declared({
      status: "mapped",
      operations: [
        {
          operationId: "v1-list-all-secrets",
          kind: "required",
          when: [{ flag: "skip", is: false }],
        },
      ],
      noApiEffectFlags: [],
    });
    const rejected: Array<Record<string, boolean | string>> = [{}, { skip: "false" }];
    for (const activeFlags of rejected) {
      expect(() =>
        assertDriftAgainst(switchChecked, {
          command: "secrets list",
          activeFlags,
          requests: [listSecrets],
        }),
      ).toThrow(/checks the value of --skip, a switch — pass its effective value as a boolean/);
    }
    expect(() =>
      assertDriftAgainst(switchChecked, {
        command: "secrets list",
        activeFlags: { skip: false },
        requests: [listSecrets],
      }),
    ).not.toThrow();
  });

  it("rejects an active flag the command does not accept, even if a declaration condition names it", () => {
    const withBlockCondition = declared({
      status: "mapped",
      operations: [
        { operationId: "v1-list-all-secrets", kind: "required" },
        { operationId: "v1-run-a-query", kind: "required", when: [{ flag: "password" }] },
      ],
      noApiEffectFlags: [],
    });
    expect(() =>
      assertDriftAgainst(withBlockCondition, {
        command: "db query",
        activeFlags: { password: true },
        acceptedFlags: new Set(["linked", "output"]),
        requests: [],
      }),
    ).toThrow(/does not accept --password/);
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
        activeFlags: {},
        requests: [runQuery],
      }),
    ).toThrow(/"v1-run-a-query", which is declared for this command but whose `when` condition/);
  });

  describe("selector conditions", () => {
    const branchLookup = declared({
      status: "mapped",
      operations: [
        { operationId: "v1-list-all-secrets", kind: "required" },
        {
          operationId: "v1-list-all-branches",
          kind: "required",
          when: [{ selector: ["branch"] }],
        },
      ],
      noApiEffectFlags: [],
    });
    const listBranches = { method: "GET", url: `${API}/v1/projects/${REF}/branches` };

    it("accepts the branch listing only when a selector flag names a branch", () => {
      const check = (activeFlags: Record<string, string | boolean>) =>
        assertDriftAgainst(branchLookup, {
          command: "secrets list",
          activeFlags,
          requests: [listSecrets, listBranches],
        });
      expect(() => check({ remote: "feature-x" })).not.toThrow();
      expect(() => check({ "project-ref": "feature-x" })).not.toThrow();
      expect(() => check({ remote: REF })).toThrow(/"v1-list-all-branches", which is declared/);
      expect(() => check({})).toThrow(/"v1-list-all-branches", which is declared/);
    });

    it("classifies every flag that can carry the selector", () => {
      for (const flag of ["remote", "linked", "project-ref", "project-id", "db-url", "local"]) {
        expect(() =>
          assertDriftAgainst(branchLookup, {
            command: "secrets list",
            activeFlags: { [flag]: true },
            requests: [],
          }),
        ).not.toThrow();
      }
    });
  });

  describe("request qualifiers", () => {
    const apiKeys = `${API}/v1/projects/${REF}/api-keys`;
    const withReveal = declared({
      status: "mapped",
      operations: [
        {
          operationId: "v1-get-project-api-keys",
          kind: "required",
          request: { query: { reveal: "true" } },
        },
      ],
      noApiEffectFlags: [],
    });
    const revealOnlyWithFlag = declared({
      status: "mapped",
      operations: [
        { operationId: "v1-get-project-api-keys", kind: "required" },
        {
          operationId: "v1-get-project-api-keys",
          kind: "required",
          when: [{ flag: "reveal" }],
          request: { query: { reveal: "true" } },
        },
      ],
      noApiEffectFlags: [],
    });
    const check = (
      lookup: DeclaredPermissionsLookup,
      request: { method: string; url: string; urlParams?: string },
      activeFlags: Record<string, boolean> = {},
    ) => assertDriftAgainst(lookup, { command: "keys", activeFlags, requests: [request] });

    it("accepts a request carrying the declared qualifier in its url or its urlParams", () => {
      expect(() =>
        check(withReveal, { method: "GET", url: `${apiKeys}?reveal=true` }),
      ).not.toThrow();
      expect(() =>
        check(withReveal, { method: "GET", url: apiKeys, urlParams: "reveal=true" }),
      ).not.toThrow();
    });

    it("rejects a request sent without the declared qualifier or with another value", () => {
      expect(() => check(withReveal, { method: "GET", url: apiKeys })).toThrow(
        /sent without the query qualifiers its declaration lists/,
      );
      expect(() =>
        check(withReveal, { method: "GET", url: apiKeys, urlParams: "reveal=false" }),
      ).toThrow(/sent without the query qualifiers/);
    });

    it("rejects a qualifier the declaration lists only under a flag the run does not use", () => {
      const plain = { method: "GET", url: apiKeys };
      const revealed = { method: "GET", url: apiKeys, urlParams: "reveal=true" };
      expect(() => check(revealOnlyWithFlag, plain)).not.toThrow();
      expect(() => check(revealOnlyWithFlag, revealed)).toThrow(
        /carries reveal=true, which no applicable declaration entry lists/,
      );
      expect(() => check(revealOnlyWithFlag, revealed, { reveal: true })).not.toThrow();
    });
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
          activeFlags: { linked: true },
          requests: [listSecrets],
          exact: true,
        }),
      ).toThrow(/expected these required operations to be requested but none were: v1-run-a-query/);
    });

    it("does not require an operation whose condition does not hold", () => {
      expect(() =>
        assertDriftAgainst(mappedCommand, {
          command: "secrets list",
          activeFlags: {},
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

describe("assertBlockDrift", () => {
  const demo = block("demo", [
    { operationId: "v1-list-all-secrets", kind: "required" },
    { operationId: "v1-run-a-query", kind: "required", when: [{ flag: "linked" }] },
  ]);

  it("names the building block when a request is to an operation it does not declare", () => {
    expect(() => assertBlockDrift(demo, { requests: [getProject] })).toThrow(
      /assertBlockDrift: building block "demo": request GET .*"v1-get-project", which is not declared for this building block at all/,
    );
  });

  it("rejects a declared operation whose condition does not hold for the active flags", () => {
    expect(() => assertBlockDrift(demo, { activeFlags: {}, requests: [runQuery] })).toThrow(
      /assertBlockDrift: building block "demo": .*"v1-run-a-query", which is declared for this building block but whose `when` condition/,
    );
  });

  it("names the building block when a switch the block tests is missing from activeFlags", () => {
    const switched = block("switched", [
      { operationId: "v1-list-all-secrets", kind: "required", when: [{ flag: "skip", is: false }] },
    ]);
    expect(() => assertBlockDrift(switched, { requests: [listSecrets] })).toThrow(
      /assertBlockDrift: building block "switched": a `when` condition checks the value of --skip/,
    );
  });
});
