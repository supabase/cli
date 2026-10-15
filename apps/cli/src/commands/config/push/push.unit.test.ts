import { describe, expect, test } from "vitest";

import type { ConfigPushTarget } from "./push.branch-target.ts";
import {
  configPushPayloadFields,
  configPushTargetLines,
  pushConsentAction,
  pushCostLine,
} from "./push.format.ts";

const REF = "abcdefghijklmnopqrst";
const PARENT_REF = "pppppppppppppppppppp";

describe("configPushTargetLines", () => {
  test("a plain project with no known name stays byte-identical to the pre-CLI-2168 line", () => {
    expect(configPushTargetLines({ kind: "project", ref: REF })).toBe(
      `Pushing config to project: ${REF}\n`,
    );
  });

  test("a plain project with a known name shows the name alongside the ref", () => {
    expect(configPushTargetLines({ kind: "project", ref: REF, name: "Test Project" })).toBe(
      `Pushing config to project: Test Project (${REF})\n`,
    );
  });

  test("a named branch with a named parent shows both lines", () => {
    const target: ConfigPushTarget = {
      kind: "branch",
      ref: REF,
      branch: "feat-x",
      parentRef: PARENT_REF,
      parentName: "My App",
    };
    expect(configPushTargetLines(target)).toBe(
      `Pushing config to branch: feat-x (${REF})\n  Parent project: My App (${PARENT_REF})\n`,
    );
  });

  test("a named branch with a known but unnamed parent omits the parent's name", () => {
    const target: ConfigPushTarget = {
      kind: "branch",
      ref: REF,
      branch: "feat-x",
      parentRef: PARENT_REF,
    };
    expect(configPushTargetLines(target)).toBe(
      `Pushing config to branch: feat-x (${REF})\n  Parent project: ${PARENT_REF}\n`,
    );
  });

  test("a named branch with no known parent at all omits the parent line entirely", () => {
    const target: ConfigPushTarget = { kind: "branch", ref: REF, branch: "feat-x" };
    expect(configPushTargetLines(target)).toBe(`Pushing config to branch: feat-x (${REF})\n`);
  });

  test("an unnamed branch with a named parent shows a bare branch ref and the parent's name", () => {
    const target: ConfigPushTarget = {
      kind: "branch",
      ref: REF,
      parentRef: PARENT_REF,
      parentName: "My App",
    };
    expect(configPushTargetLines(target)).toBe(
      `Pushing config to branch: ${REF}\n  Parent project: My App (${PARENT_REF})\n`,
    );
  });

  test("a bare branch with nothing else known renders a single line", () => {
    expect(configPushTargetLines({ kind: "branch", ref: REF })).toBe(
      `Pushing config to branch: ${REF}\n`,
    );
  });

  test("control characters and ANSI escapes in a project name are sanitized", () => {
    // Routes through `formatNamedRef`/`sanitizeInlineName` (not
    // re-tested here) — this asserts the formatter actually calls it, not
    // that the sanitizer itself works.
    const rendered = configPushTargetLines({
      kind: "project",
      ref: REF,
      name: "evil\x1b[31mred",
    });
    expect(rendered).toBe(`Pushing config to project: evil[31mred (${REF})\n`);
    expect(rendered).not.toContain("\x1b");
  });

  test("a newline in a branch/parent name is collapsed instead of forging extra output lines", () => {
    const target: ConfigPushTarget = {
      kind: "branch",
      ref: REF,
      branch: "evil\nbranch",
      parentRef: PARENT_REF,
      parentName: "evil\nparent",
    };
    expect(configPushTargetLines(target)).toBe(
      `Pushing config to branch: evil branch (${REF})\n  Parent project: evil parent (${PARENT_REF})\n`,
    );
  });
});

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
