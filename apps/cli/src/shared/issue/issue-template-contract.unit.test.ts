import { describe, expect, it } from "@effect/vitest";
import { BunServices } from "@effect/platform-bun";
import { Effect, FileSystem, Layer, Path } from "effect";
import { parse } from "yaml";
import {
  buildIssueUrl,
  inferIssueInstallMethod,
  issueInstallMethodValues,
  issueTemplateContract,
} from "./issue-url.ts";
import { RuntimeInfo } from "../runtime/runtime-info.service.ts";
import { runtimeInfoLayer } from "../runtime/runtime-info.layer.ts";

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

const testLayer = Layer.mergeAll(BunServices.layer, runtimeInfoLayer);

const issueTemplateDir = Effect.gen(function* () {
  const runtimeInfo = yield* RuntimeInfo;
  const path = yield* Path.Path;
  return path.resolve(runtimeInfo.cwd, "../../.github/ISSUE_TEMPLATE");
});

function readTemplate(templateDir: string, template: string) {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const parsed = parse(yield* fs.readFileString(path.resolve(templateDir, template)));
    if (!isRecord(parsed) || !Array.isArray(parsed.body)) return [];
    return parsed.body.filter(isBodyItem);
  });
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
    const fieldId = item.id;
    return options.flatMap((option: IssueFormOption) => {
      if (typeof option === "string") return [];
      return option.required === true ? [`${fieldId}:${String(option.label)}`] : [];
    });
  });
}

describe("issue template contract", () => {
  it.effect("points to issue form templates that exist", () =>
    Effect.gen(function* () {
      const templateDir = yield* issueTemplateDir;
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      for (const form of Object.values(issueTemplateContract)) {
        expect(yield* fs.exists(path.resolve(templateDir, form.template))).toBe(true);
      }
    }).pipe(Effect.provide(testLayer)),
  );

  it.effect("keeps issue command field ids aligned with the GitHub issue forms", () =>
    Effect.gen(function* () {
      const templateDir = yield* issueTemplateDir;
      for (const form of Object.values(issueTemplateContract)) {
        const ids = fieldIds(yield* readTemplate(templateDir, form.template));
        expect(ids).toEqual(expect.arrayContaining([...form.fields]));
        expect(form.fields).toEqual(expect.arrayContaining(ids));
      }
    }).pipe(Effect.provide(testLayer)),
  );

  it.effect("keeps issue command prefilled option values valid for their fields", () =>
    Effect.gen(function* () {
      const templateDir = yield* issueTemplateDir;
      for (const form of Object.values(issueTemplateContract)) {
        const body = yield* readTemplate(templateDir, form.template);
        for (const [fieldId, values] of Object.entries(form.optionValues)) {
          const item = body.find((entry) => entry.id === fieldId);
          expect(item, `${form.template} should include field ${fieldId}`).toBeDefined();
          if (item === undefined) continue;
          expect(optionLabels(item)).toEqual(expect.arrayContaining([...values]));
        }
      }
    }).pipe(Effect.provide(testLayer)),
  );

  it("keeps inferred install methods compatible with the template dropdown", () => {
    const cases = [
      { userAgent: "pnpm/10.0.0", execPath: "/usr/local/bin/supabase", expected: "pnpm" },
      { userAgent: "npm/11.0.0", execPath: "/usr/local/bin/supabase", expected: "npm" },
      { userAgent: "yarn/4.0.0", execPath: "/usr/local/bin/supabase", expected: "yarn" },
      { userAgent: "bun/1.2.0", execPath: "/usr/local/bin/supabase", expected: "bun" },
      { userAgent: undefined, execPath: "/opt/homebrew/bin/supabase", expected: "brew" },
      { userAgent: undefined, execPath: "/usr/local/bin/supabase", expected: "Other" },
    ] as const;

    for (const testcase of cases) {
      const value = inferIssueInstallMethod(
        { execPath: testcase.execPath },
        { npm_config_user_agent: testcase.userAgent },
      );
      expect(value).toBe(testcase.expected);
      expect(issueInstallMethodValues).toContain(value);
    }

    expect(
      inferIssueInstallMethod(
        { execPath: "/usr/local/bin/supabase" },
        { SUPABASE_INSTALL_METHOD: "Docker image" },
      ),
    ).toBe("Docker image");
    expect(
      inferIssueInstallMethod(
        { execPath: "/usr/local/bin/supabase" },
        { SUPABASE_INSTALL_METHOD: "asdf" },
      ),
    ).toBe("Other");
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

  it.effect("keeps issue form required fields aligned with the command contract", () =>
    Effect.gen(function* () {
      const templateDir = yield* issueTemplateDir;
      for (const form of Object.values(issueTemplateContract)) {
        const body = yield* readTemplate(templateDir, form.template);
        expect(requiredFields(body)).toEqual([...form.requiredFields]);
      }
    }).pipe(Effect.provide(testLayer)),
  );
});
