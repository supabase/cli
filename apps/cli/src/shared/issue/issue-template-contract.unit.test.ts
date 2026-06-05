import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import {
  buildIssueUrl,
  inferIssueInstallMethod,
  issueInstallMethodValues,
  issueTemplateContract,
} from "./issue-url.ts";

type IssueFormOption =
  | string
  | {
      readonly label?: unknown;
      readonly required?: unknown;
    };

type IssueFormBodyItem = {
  readonly id?: unknown;
  readonly validations?: {
    readonly required?: unknown;
  };
  readonly attributes?: {
    readonly options?: unknown;
  };
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isBodyItem(value: unknown): value is IssueFormBodyItem {
  return isRecord(value);
}

function issueTemplateDir() {
  return resolve(process.cwd(), "../../.github/ISSUE_TEMPLATE");
}

function readTemplate(template: string): ReadonlyArray<IssueFormBodyItem> {
  const path = resolve(issueTemplateDir(), template);
  const parsed = parse(readFileSync(path, "utf8"));
  if (!isRecord(parsed) || !Array.isArray(parsed.body)) return [];
  return parsed.body.filter(isBodyItem);
}

function fieldIds(body: ReadonlyArray<IssueFormBodyItem>) {
  return body.flatMap((item) => (typeof item.id === "string" ? [item.id] : []));
}

function optionLabels(item: IssueFormBodyItem) {
  const options = item.attributes?.options;
  if (!Array.isArray(options)) return [];
  return options.flatMap((option: IssueFormOption) => {
    if (typeof option === "string") return [option];
    if (typeof option.label === "string") return [option.label];
    return [];
  });
}

function requiredFields(body: ReadonlyArray<IssueFormBodyItem>) {
  return body.flatMap((item) => {
    if (item.validations?.required === true && typeof item.id === "string") {
      return [item.id];
    }

    const options = item.attributes?.options;
    if (!Array.isArray(options) || typeof item.id !== "string") return [];
    return options.flatMap((option: IssueFormOption) => {
      if (typeof option === "string") return [];
      return option.required === true ? [`${item.id}:${String(option.label)}`] : [];
    });
  });
}

describe("issue template contract", () => {
  it("points to issue form templates that exist", () => {
    for (const form of Object.values(issueTemplateContract)) {
      expect(existsSync(resolve(issueTemplateDir(), form.template))).toBe(true);
    }
  });

  it("keeps issue command field ids aligned with the GitHub issue forms", () => {
    for (const form of Object.values(issueTemplateContract)) {
      const ids = fieldIds(readTemplate(form.template));
      expect(ids).toEqual(expect.arrayContaining([...form.fields]));
      expect(form.fields).toEqual(expect.arrayContaining(ids));
    }
  });

  it("keeps issue command prefilled option values valid for their fields", () => {
    for (const form of Object.values(issueTemplateContract)) {
      const body = readTemplate(form.template);
      for (const [fieldId, values] of Object.entries(form.optionValues)) {
        const item = body.find((entry) => entry.id === fieldId);
        expect(item, `${form.template} should include field ${fieldId}`).toBeDefined();
        expect(optionLabels(item!)).toEqual(expect.arrayContaining([...values]));
      }
    }
  });

  it("keeps inferred install methods compatible with the template dropdown", () => {
    const originalUserAgent = process.env["npm_config_user_agent"];
    const originalInstallMethod = process.env["SUPABASE_INSTALL_METHOD"];
    const cases = [
      { userAgent: "pnpm/10.0.0", execPath: "/usr/local/bin/supabase", expected: "pnpm" },
      { userAgent: "npm/11.0.0", execPath: "/usr/local/bin/supabase", expected: "npm" },
      { userAgent: "yarn/4.0.0", execPath: "/usr/local/bin/supabase", expected: "yarn" },
      { userAgent: "bun/1.2.0", execPath: "/usr/local/bin/supabase", expected: "bun" },
      { userAgent: undefined, execPath: "/opt/homebrew/bin/supabase", expected: "brew" },
      { userAgent: undefined, execPath: "/usr/local/bin/supabase", expected: "Other" },
    ] as const;

    try {
      delete process.env["SUPABASE_INSTALL_METHOD"];
      for (const testcase of cases) {
        if (testcase.userAgent === undefined) {
          delete process.env["npm_config_user_agent"];
        } else {
          process.env["npm_config_user_agent"] = testcase.userAgent;
        }
        const value = inferIssueInstallMethod({ execPath: testcase.execPath });
        expect(value).toBe(testcase.expected);
        expect(issueInstallMethodValues).toContain(value);
      }

      process.env["SUPABASE_INSTALL_METHOD"] = "Docker image";
      expect(inferIssueInstallMethod({ execPath: "/usr/local/bin/supabase" })).toBe("Docker image");

      process.env["SUPABASE_INSTALL_METHOD"] = "asdf";
      expect(inferIssueInstallMethod({ execPath: "/usr/local/bin/supabase" })).toBe("Other");
    } finally {
      if (originalUserAgent === undefined) delete process.env["npm_config_user_agent"];
      else process.env["npm_config_user_agent"] = originalUserAgent;
      if (originalInstallMethod === undefined) delete process.env["SUPABASE_INSTALL_METHOD"];
      else process.env["SUPABASE_INSTALL_METHOD"] = originalInstallMethod;
    }
  });

  it("keeps generated issue URLs under the browser-friendly limit", () => {
    const longField = "x".repeat(4_000);
    const url = buildIssueUrl({
      template: "bug-report.yml",
      fields: Object.fromEntries(
        issueTemplateContract.bug.fields.map((field) => [field, longField]),
      ),
    });

    expect(url.length).toBeLessThanOrEqual(8_000);
  });

  it("keeps issue form required fields aligned with the command contract", () => {
    for (const form of Object.values(issueTemplateContract)) {
      expect(requiredFields(readTemplate(form.template))).toEqual([...form.requiredFields]);
    }
  });
});
