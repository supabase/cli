import { describe, expect, test } from "vitest";

import { configPushPayloadFields, pushConsentAction, pushCostLine } from "./push.format.ts";

const REF = "abcdefghijklmnopqrst";
const PARENT_REF = "pppppppppppppppppppp";

describe("pushConsentAction", () => {
  test("names a single service", () => {
    expect(pushConsentAction(["auth"])).toBe("push config changes to Auth");
  });

  test("joins two services with and", () => {
    expect(pushConsentAction(["api", "storage"])).toBe("push config changes to API and Storage");
  });

  test("joins three or more with commas and a final and, including webhooks", () => {
    expect(pushConsentAction(["api", "db.settings", "experimental.webhooks"])).toBe(
      "push config changes to API, DB and Webhooks",
    );
  });
});

describe("pushCostLine", () => {
  test("states the addon and its price", () => {
    expect(pushCostLine({ name: "Phone MFA", price: "$75.00/ month" })).toBe(
      "Enabling Phone MFA will cost you $75.00/ month.\n",
    );
  });
});

describe("configPushPayloadFields", () => {
  test("a plain project carries only is_branch: false", () => {
    expect(configPushPayloadFields({ kind: "project", ref: REF })).toEqual({
      is_branch: false,
    });
  });

  test("a named branch with a known parent carries both branch and parent_project_ref", () => {
    expect(
      configPushPayloadFields({
        kind: "branch",
        ref: REF,
        branch: "feat-x",
        parentRef: PARENT_REF,
      }),
    ).toEqual({ is_branch: true, branch: "feat-x", parent_project_ref: PARENT_REF });
  });

  test("a named branch with no known parent omits parent_project_ref", () => {
    expect(configPushPayloadFields({ kind: "branch", ref: REF, branch: "feat-x" })).toEqual({
      is_branch: true,
      branch: "feat-x",
    });
  });

  test("an unnamed branch with a known parent omits branch", () => {
    expect(configPushPayloadFields({ kind: "branch", ref: REF, parentRef: PARENT_REF })).toEqual({
      is_branch: true,
      parent_project_ref: PARENT_REF,
    });
  });

  test("a bare branch with nothing known carries only is_branch: true", () => {
    expect(configPushPayloadFields({ kind: "branch", ref: REF })).toEqual({
      is_branch: true,
    });
  });
});
