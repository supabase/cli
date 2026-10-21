import { Flag } from "effect/cli";
import type { Param } from "effect/cli";
import { describe, expect, it } from "vitest";

import { renderPermissionsSection, resolvePermissionSection } from "./help-section.ts";
import { mapped } from "./model.ts";
import type { CommandPermissions, OperationEntry } from "./model.ts";
import { permissionFlagsOf } from "./permission-flags.ts";
import type { FlagCatalog } from "./permission-flags.ts";
import { fgaScheme, oauthScheme } from "./permission-schemes.ts";
import type { PermissionScheme } from "./permission-schemes.ts";

const catalogOf = (...params: ReadonlyArray<Param.AnyFlag>): FlagCatalog =>
  new Map(permissionFlagsOf(params).map((flag) => [flag.name, flag]));

const switchFlag = (name: string) => Flag.Boolean(name).pipe(Flag.withDefault(false));
const projectRef = Flag.String("project-ref").pipe(Flag.optional);

interface Declaration {
  readonly operations: ReadonlyArray<OperationEntry>;
  readonly dbTargetDefault?: "local" | "linked";
}

function render(
  declaration: Declaration,
  catalog: FlagCatalog = catalogOf(),
  schemes?: ReadonlyArray<PermissionScheme>,
): string | undefined {
  const section = resolvePermissionSection(mapped(declaration), catalog, schemes);
  return section === undefined ? undefined : renderPermissionsSection(section);
}

const lines = (...text: ReadonlyArray<string>) => text.join("\n");
const fga = "  Scoped access token:";

describe("permission help section", () => {
  describe("conditions", () => {
    it("drops a switch condition when the operation is declared with and without it", () => {
      const text = render(
        {
          operations: [
            {
              operationId: "v1-list-all-projects",
              kind: "required",
              when: [{ flag: "dry", is: true }],
            },
            {
              operationId: "v1-list-all-projects",
              kind: "required",
              when: [{ flag: "dry", is: false }],
            },
          ],
        },
        catalogOf(switchFlag("dry")),
      );

      expect(text).toBe(lines("PERMISSIONS", fga, "    Required:", "      projects_read"));
    });

    it("merges a flag's given, empty and unset cases into one unconditional entry", () => {
      const operation = { operationId: "v1-get-pooler-config", kind: "required" } as const;
      const text = render(
        {
          operations: [
            { ...operation, when: [{ flag: "project-ref" }] },
            { ...operation, when: [{ flag: "project-ref", oneOf: [""] }] },
            { ...operation, when: [{ flag: "project-ref", present: false }] },
          ],
        },
        catalogOf(projectRef),
      );

      expect(text).toBe(
        lines("PERMISSIONS", fga, "    Required:", "      database_pooling_config_read"),
      );
    });

    it("words an empty value as the flag being given", () => {
      const operation = { operationId: "v1-get-pooler-config", kind: "required" } as const;
      const text = render(
        {
          operations: [
            { ...operation, when: [{ flag: "project-ref" }] },
            { ...operation, when: [{ flag: "project-ref", oneOf: [""] }] },
          ],
        },
        catalogOf(projectRef),
      );

      expect(text).toBe(
        lines(
          "PERMISSIONS",
          fga,
          "    Required with --project-ref:",
          "      database_pooling_config_read",
        ),
      );
    });

    it("drops a condition once a choice flag's values cover every choice", () => {
      const type = Flag.Literals("type", ["security", "performance", "all"] as const).pipe(
        Flag.optional,
      );
      const text = render(
        {
          operations: [
            {
              operationId: "v1-get-security-advisors",
              kind: "required",
              when: [{ flag: "type", oneOf: ["all", "security"] }],
            },
            {
              operationId: "v1-get-security-advisors",
              kind: "required",
              when: [{ flag: "type", present: false }],
            },
            {
              operationId: "v1-get-performance-advisors",
              kind: "required",
              when: [{ flag: "type", oneOf: ["all", "performance"] }],
            },
            {
              operationId: "v1-get-performance-advisors",
              kind: "required",
              when: [{ flag: "type", present: false }],
            },
          ],
        },
        catalogOf(type),
      );

      expect(text).toBe(lines("PERMISSIONS", fga, "    Required:", "      advisors_read"));
    });

    it("names the values of a choice flag when they do not cover every choice", () => {
      const lang = Flag.Literals("lang", ["typescript", "go", "swift"] as const).pipe(
        Flag.withDefault("typescript" as const),
      );
      const text = render(
        {
          operations: [
            { operationId: "v1-list-all-projects", kind: "required" },
            {
              operationId: "v1-get-project",
              kind: "required",
              when: [{ flag: "lang", oneOf: ["go", "swift"] }],
            },
          ],
        },
        catalogOf(lang),
      );

      expect(text).toBe(
        lines(
          "PERMISSIONS",
          fga,
          "    Required:",
          "      projects_read",
          "    Required with --lang=go|swift:",
          "      project_admin_read",
        ),
      );
    });

    it("adds 'or unset' to text and the default to data, only when the condition includes the default", () => {
      const lang = Flag.Literals("lang", ["typescript", "go", "swift"] as const).pipe(
        Flag.withDefault("typescript" as const),
      );
      const declaration = (values: ReadonlyArray<string>): Declaration => ({
        operations: [
          { operationId: "v1-list-all-projects", kind: "required" },
          {
            operationId: "v1-get-project",
            kind: "required",
            when: [{ flag: "lang", oneOf: values }],
          },
        ],
      });
      const catalog = catalogOf(lang);
      const groupOf = (values: ReadonlyArray<string>) => {
        const section = resolvePermissionSection(mapped(declaration(values)), catalog);
        if (section?.status !== "mapped") throw new Error("expected a mapped section");
        return section.schemes[0]?.groups[1];
      };

      expect(groupOf(["typescript"])).toMatchObject({
        heading: "Required with --lang=typescript or unset",
        when: [{ all: [{ flag: "lang", values: ["typescript"], default: "typescript" }] }],
      });
      expect(groupOf(["typescript", "go"])).toMatchObject({
        heading: "Required with --lang=typescript|go or unset",
      });
      expect(groupOf(["go"])?.when).toEqual([{ all: [{ flag: "lang", values: ["go"] }] }]);
      expect(groupOf(["go"])?.heading).toBe("Required with --lang=go");
    });

    it("ignores a condition on a flag the command lacks when it holds for an unset flag", () => {
      const text = render({
        operations: [
          {
            operationId: "v1-list-all-projects",
            kind: "required",
            when: [{ flag: "password", present: false }],
          },
          {
            operationId: "v1-get-project",
            kind: "best-effort",
            when: [{ flag: "gone", is: false }],
          },
        ],
      });

      expect(text).toBe(
        lines(
          "PERMISSIONS",
          fga,
          "    Required:",
          "      projects_read",
          "    Optional (command still runs without these):",
          "      project_admin_read",
        ),
      );
    });

    it("drops an entry whose condition needs a flag the command lacks", () => {
      const text = render({
        operations: [
          { operationId: "v1-list-all-projects", kind: "required" },
          { operationId: "v1-get-project", kind: "required", when: [{ flag: "gone", is: true }] },
        ],
      });

      expect(text).toBe(lines("PERMISSIONS", fga, "    Required:", "      projects_read"));
    });

    it("never names a hidden flag, and hedges what it gated", () => {
      const hidden = Flag.Boolean("legacy").pipe(Flag.withDefault(false), Flag.withHidden);
      const text = render(
        {
          operations: [
            {
              operationId: "v1-list-all-projects",
              kind: "required",
              when: [{ flag: "legacy", is: true }],
            },
          ],
        },
        catalogOf(hidden),
      );

      expect(text).toBe(lines("PERMISSIONS", fga, "    May be required:", "      projects_read"));
    });

    it("covers every value of a text flag when a literal, any value and no value all apply", () => {
      const from = Flag.String("from").pipe(Flag.optional);
      const operation = { operationId: "v1-get-pooler-config", kind: "required" } as const;
      const text = render(
        {
          operations: [
            { ...operation, when: [{ flag: "from", oneOf: ["linked"] }] },
            { ...operation, when: [{ flag: "from" }] },
            { ...operation, when: [{ flag: "from", present: false }] },
          ],
        },
        catalogOf(from),
      );

      expect(text).toBe(
        lines("PERMISSIONS", fga, "    Required:", "      database_pooling_config_read"),
      );
    });

    it("words a text flag's literal and any given value as the flag being given", () => {
      const from = Flag.String("from").pipe(Flag.optional);
      const operation = { operationId: "v1-get-pooler-config", kind: "required" } as const;
      const text = render(
        {
          operations: [
            { operationId: "v1-list-all-projects", kind: "required" },
            { ...operation, when: [{ flag: "from", oneOf: ["linked"] }] },
            { ...operation, when: [{ flag: "from" }] },
          ],
        },
        catalogOf(from),
      );

      expect(text).toBe(
        lines(
          "PERMISSIONS",
          fga,
          "    Required:",
          "      projects_read",
          "    Required with --from:",
          "      database_pooling_config_read",
        ),
      );
    });

    it("keeps a condition on an optional choice flag even when it names every choice", () => {
      const type = Flag.Literals("type", ["security", "performance"] as const).pipe(Flag.optional);
      const text = render(
        {
          operations: [
            { operationId: "v1-list-all-projects", kind: "required" },
            { operationId: "v1-get-project", kind: "required", when: [{ flag: "type" }] },
          ],
        },
        catalogOf(type),
      );

      expect(text).toBe(
        lines(
          "PERMISSIONS",
          fga,
          "    Required:",
          "      projects_read",
          "    Required with --type=security|performance:",
          "      project_admin_read",
        ),
      );
    });

    it("separates alternatives that each combine several flags", () => {
      const operation = { operationId: "v1-get-pooler-config", kind: "required" } as const;
      const text = render(
        {
          operations: [
            { operationId: "v1-list-all-projects", kind: "required" },
            {
              ...operation,
              when: [
                { flag: "a", is: true },
                { flag: "b", is: true },
              ],
            },
            {
              ...operation,
              when: [
                { flag: "c", is: true },
                { flag: "d", is: false },
              ],
            },
          ],
        },
        catalogOf(switchFlag("a"), switchFlag("b"), switchFlag("c"), switchFlag("d")),
      );

      expect(text).toContain(
        "    Required with --a and --b; or with --c, without --d:\n      database_pooling_config_read",
      );
    });

    it("words alternative flags as one list", () => {
      const text = render(
        {
          operations: [
            {
              operationId: "v1-get-pooler-config",
              kind: "required",
              when: [{ flag: "from", oneOf: ["linked"] }],
            },
            {
              operationId: "v1-get-pooler-config",
              kind: "required",
              when: [{ flag: "to", oneOf: ["linked"] }],
            },
          ],
        },
        catalogOf(Flag.String("from").pipe(Flag.optional), Flag.String("to").pipe(Flag.optional)),
      );

      expect(text).toBe(
        lines(
          "PERMISSIONS",
          fga,
          "    Required with --from=linked or --to=linked:",
          "      database_pooling_config_read",
        ),
      );
    });
  });

  describe("grouping", () => {
    it("lists a permission once, under the strongest group that covers it", () => {
      const text = render(
        {
          operations: [
            { operationId: "v1-get-project", kind: "best-effort" },
            { operationId: "v1-get-project", kind: "required" },
            {
              operationId: "v1-get-pooler-config",
              kind: "required",
              when: [{ flag: "dry", is: false }],
            },
            { operationId: "v1-get-pooler-config", kind: "required" },
          ],
        },
        catalogOf(switchFlag("dry")),
      );

      expect(text).toBe(
        lines(
          "PERMISSIONS",
          fga,
          "    Required:",
          "      project_admin_read",
          "      database_pooling_config_read",
        ),
      );
    });

    it("drops an Optional row that a May be required group already lists", () => {
      const text = render({
        operations: [
          { operationId: "v1-get-project", kind: "required", context: "a prompt picks it" },
          { operationId: "v1-get-project", kind: "best-effort" },
        ],
      });

      expect(text).toBe(
        lines("PERMISSIONS", fga, "    May be required:", "      project_admin_read"),
      );
    });

    it("keeps a permission under Required when a situational group also lists it", () => {
      const text = render({
        operations: [
          { operationId: "v1-get-project", kind: "required" },
          { operationId: "v1-get-project", kind: "required", context: "a prompt picks it" },
        ],
      });

      expect(text).toBe(lines("PERMISSIONS", fga, "    Required:", "      project_admin_read"));
    });

    it("does not call a permission optional when another heading requires it", () => {
      const text = render(
        {
          operations: [
            {
              operationId: "v1-get-project",
              kind: "required",
              when: [{ flag: "strict", is: true }],
            },
            { operationId: "v1-get-project", kind: "best-effort" },
            { operationId: "v1-list-all-projects", kind: "required" },
          ],
        },
        catalogOf(switchFlag("strict")),
      );

      expect(text).toBe(
        lines(
          "PERMISSIONS",
          fga,
          "    Required:",
          "      projects_read",
          "    Required with --strict:",
          "      project_admin_read",
        ),
      );
    });

    it("never shows the reason behind a situational entry", () => {
      const text = render({
        operations: [
          {
            operationId: "v1-get-project",
            kind: "required",
            context: "the user picks the project",
          },
        ],
      });

      expect(text).toBe(
        lines("PERMISSIONS", fga, "    May be required:", "      project_admin_read"),
      );
      expect(text).not.toContain("picks");
    });

    it("orders required before optional and unconditional before conditional", () => {
      const text = render(
        {
          operations: [
            { operationId: "v1-get-project", kind: "best-effort" },
            { operationId: "v1-get-pooler-config", kind: "required", context: "needs a ref" },
            {
              operationId: "v1-get-database-metadata",
              kind: "required",
              when: [{ flag: "dry", is: true }],
            },
            { operationId: "v1-list-all-projects", kind: "required" },
          ],
        },
        catalogOf(switchFlag("dry")),
      );

      expect(text).toBe(
        lines(
          "PERMISSIONS",
          fga,
          "    Required:",
          "      projects_read",
          "    Required with --dry:",
          "      database_read",
          "    May be required:",
          "      database_pooling_config_read",
          "    Optional (command still runs without these):",
          "      project_admin_read",
        ),
      );
    });
  });

  describe("shared conditions", () => {
    it("says a command is not needed with the flags every entry excludes", () => {
      const text = render(
        {
          operations: [
            {
              operationId: "v1-list-all-projects",
              kind: "required",
              when: [{ flag: "local", is: false }],
            },
            {
              operationId: "v1-get-project",
              kind: "best-effort",
              when: [{ flag: "local", is: false }],
            },
          ],
        },
        catalogOf(switchFlag("local")),
      );

      expect(text).toBe(
        lines(
          "PERMISSIONS",
          "  Not needed with --local.",
          fga,
          "    Required:",
          "      projects_read",
          "    Optional (command still runs without these):",
          "      project_admin_read",
        ),
      );
    });

    it("says a command is only needed with the flag every entry requires", () => {
      const text = render(
        {
          operations: [
            {
              operationId: "v1-list-all-projects",
              kind: "required",
              when: [{ flag: "linked", is: true }],
            },
          ],
        },
        catalogOf(switchFlag("linked")),
      );

      expect(text).toBe(
        lines(
          "PERMISSIONS",
          "  Only needed with --linked.",
          fga,
          "    Required:",
          "      projects_read",
        ),
      );
    });

    it("says it is not needed with the other targets when the default is the linked project", () => {
      const text = render(
        {
          dbTargetDefault: "linked",
          operations: [
            {
              operationId: "v1-list-all-projects",
              kind: "required",
              when: [{ dbTarget: ["linked"] }],
            },
          ],
        },
        catalogOf(
          switchFlag("local"),
          Flag.String("db-url").pipe(Flag.optional),
          switchFlag("linked"),
        ),
      );

      expect(text).toBe(
        lines(
          "PERMISSIONS",
          "  Not needed with --local or --db-url.",
          fga,
          "    Required:",
          "      projects_read",
        ),
      );
    });

    it("says it is only needed with --linked when the default is the local database", () => {
      const text = render(
        {
          dbTargetDefault: "local",
          operations: [
            {
              operationId: "v1-list-all-projects",
              kind: "required",
              when: [{ dbTarget: ["linked"] }],
            },
          ],
        },
        catalogOf(switchFlag("local"), switchFlag("linked")),
      );

      expect(text).toBe(
        lines(
          "PERMISSIONS",
          "  Only needed with --linked.",
          fga,
          "    Required:",
          "      projects_read",
        ),
      );
    });

    it("keeps the target in the heading when some entries do not depend on it", () => {
      const text = render(
        {
          dbTargetDefault: "linked",
          operations: [
            {
              operationId: "v1-list-all-projects",
              kind: "required",
              when: [{ dbTarget: ["linked"] }],
            },
            { operationId: "v1-get-project", kind: "required" },
          ],
        },
        catalogOf(switchFlag("local"), switchFlag("linked")),
      );

      expect(text).toBe(
        lines(
          "PERMISSIONS",
          fga,
          "    Required:",
          "      project_admin_read",
          "    Required (remote only):",
          "      projects_read",
        ),
      );
    });

    it("drops a target condition the command cannot vary", () => {
      const text = render({
        dbTargetDefault: "linked",
        operations: [
          {
            operationId: "v1-list-all-projects",
            kind: "required",
            when: [{ dbTarget: ["linked"] }],
          },
        ],
      });

      expect(text).toBe(lines("PERMISSIONS", fga, "    Required:", "      projects_read"));
    });
  });

  describe("schemes", () => {
    it("shows the secret-read permission when the request reveals secret keys", () => {
      const text = render(
        {
          operations: [
            {
              operationId: "v1-get-project-api-keys",
              kind: "required",
              when: [{ flag: "reveal", is: true }],
              request: { query: { reveal: "true" } },
            },
            {
              operationId: "v1-get-project-api-keys",
              kind: "required",
              when: [{ flag: "reveal", is: false }],
            },
          ],
        },
        catalogOf(switchFlag("reveal")),
      );

      expect(text).toBe(
        lines(
          "PERMISSIONS",
          fga,
          "    Required with --reveal:",
          "      api_gateway_keys_read + api_gateway_keys_secret_read",
          "    Required without --reveal:",
          "      api_gateway_keys_read",
        ),
      );
    });

    it("says when the spec lists no token permission for an operation", () => {
      const text = render({
        operations: [{ operationId: "v1-authorize-user", kind: "required" }],
      });

      expect(text).toBe(
        lines(
          "PERMISSIONS",
          fga,
          "    Required:",
          "      no token permission listed in the API spec",
        ),
      );
    });

    it("asks for a user-scoped token where the profile endpoint rejects other tokens", () => {
      const text = render({ operations: [{ operationId: "v1-get-profile", kind: "required" }] });

      expect(text).toBe(
        lines(
          "PERMISSIONS",
          fga,
          "    Required:",
          "      a user-scoped token (project- and organization-scoped tokens are rejected)",
        ),
      );
    });

    it("keeps alternatives on one line while they fit the help width", () => {
      const text = render({
        operations: [{ operationId: "v1-list-all-branches", kind: "required" }],
      });

      expect(text).toBe(
        lines(
          "PERMISSIONS",
          fga,
          "    Required:",
          "      branching_development_read or branching_production_read",
        ),
      );
    });

    it("puts each alternative on its own line once together they exceed the help width", () => {
      const first = ["a".repeat(30)];
      const second = ["b".repeat(30)];
      const scheme: PermissionScheme = {
        ...fgaScheme,
        requirement: () => [{ requirement: { anyOf: [first, second] }, hedged: false }],
      };
      const text = render(
        { operations: [{ operationId: "v1-get-project", kind: "required" }] },
        catalogOf(),
        [scheme],
      );

      expect(text).toBe(
        lines("PERMISSIONS", fga, "    Required:", `      ${first[0]}`, `        or ${second[0]}`),
      );
    });

    it("shows a permission the API needs only for some requests apart from the one it always needs", () => {
      const text = render(
        {
          operations: [
            { operationId: "v1-run-a-query", kind: "required", when: [{ flag: "dry", is: true }] },
          ],
        },
        catalogOf(switchFlag("dry")),
      );

      expect(text).toBe(
        lines(
          "PERMISSIONS",
          "  Only needed with --dry.",
          fga,
          "    Required:",
          "      database_read",
          "    May be required:",
          "      database_write",
        ),
      );
    });

    it("lists a conditional extra once when several entries add it", () => {
      const text = render({
        operations: [
          { operationId: "v1-run-a-query", kind: "required" },
          { operationId: "v1-run-a-query", kind: "required", context: "a prompt picks it" },
        ],
      });

      expect(text).toBe(
        lines(
          "PERMISSIONS",
          fga,
          "    Required:",
          "      database_read",
          "    May be required:",
          "      database_write",
        ),
      );
    });

    it("hedges a conditional extra of an entry that is already situational", () => {
      const section = resolvePermissionSection(
        mapped({
          operations: [
            { operationId: "v1-run-a-query", kind: "required", context: "a prompt picks it" },
          ],
        }),
        catalogOf(),
      );

      expect(
        section?.status === "mapped" &&
          section.schemes[0]?.groups.map((group) => [group.need, group.rows]),
      ).toEqual([["maybe", [{ anyOf: [["database_read"]] }, { anyOf: [["database_write"]] }]]]);
    });

    it("names the resource that decides which permission an operation needs", () => {
      const section = resolvePermissionSection(
        mapped({ operations: [{ operationId: "v1-get-a-branch", kind: "required" }] }),
        catalogOf(),
      );
      if (section?.status !== "mapped") throw new Error("expected a mapped section");

      expect(section.schemes[0]?.groups[0]?.rows).toEqual([
        {
          cases: [
            { for: "a preview branch", allOf: ["branching_development_read"] },
            { for: "the main branch", allOf: ["branching_production_read"] },
          ],
        },
      ]);
      expect(renderPermissionsSection(section)).toBe(
        lines(
          "PERMISSIONS",
          fga,
          "    Required:",
          "      branching_development_read for a preview branch",
          "        or branching_production_read for the main branch",
        ),
      );
    });

    it("keeps a per-resource row apart from an any-of row over the same permissions", () => {
      const text = render({
        operations: [
          { operationId: "v1-list-all-branches", kind: "required" },
          { operationId: "v1-get-a-branch", kind: "required" },
        ],
      });

      expect(text).toBe(
        lines(
          "PERMISSIONS",
          fga,
          "    Required:",
          "      branching_development_read or branching_production_read",
          "      branching_development_read for a preview branch",
          "        or branching_production_read for the main branch",
        ),
      );
    });

    it("shows the permission a request body detail needs next to the plain set", () => {
      const withData = Flag.Boolean("with-data").pipe(Flag.optional);
      const text = render(
        {
          operations: [
            { operationId: "v1-create-a-branch", kind: "required" },
            {
              operationId: "v1-create-a-branch",
              kind: "required",
              when: [{ flag: "with-data" }],
              request: { body: { with_data: "true" } },
            },
          ],
        },
        catalogOf(withData),
      );

      expect(text).toBe(
        lines(
          "PERMISSIONS",
          fga,
          "    Required:",
          "      branching_development_create",
          "        or branching_production_create",
          "    Required with --with-data:",
          "      branching_production_create",
        ),
      );
    });

    it("breaks a single alternative that is too long across lines", () => {
      const longSet = ["a".repeat(30), "b".repeat(30)];
      const scheme: PermissionScheme = {
        ...fgaScheme,
        requirement: () => [{ requirement: { anyOf: [longSet, ["c"]] }, hedged: false }],
      };
      const text = render(
        { operations: [{ operationId: "v1-get-project", kind: "required" }] },
        catalogOf(),
        [scheme],
      );

      expect(text).toBe(
        lines(
          "PERMISSIONS",
          fga,
          "    Required:",
          `      ${longSet[0]}`,
          `        + ${longSet[1]}`,
          "        or c",
        ),
      );
    });

    it("renders each registered scheme as its own block", () => {
      const text = render(
        {
          operations: [
            { operationId: "v1-get-project", kind: "required" },
            { operationId: "v1-get-storage-config", kind: "best-effort" },
          ],
        },
        catalogOf(),
        [fgaScheme, oauthScheme],
      );

      expect(text).toBe(
        lines(
          "PERMISSIONS",
          fga,
          "    Required:",
          "      project_admin_read",
          "    Optional (command still runs without these):",
          "      storage_config_read",
          "  OAuth token (scopes):",
          "    Required:",
          "      projects:read",
          "    Optional (command still runs without these):",
          "      skipped with OAuth tokens (not available yet)",
        ),
      );
    });

    it("says an operation is not available with OAuth tokens yet when it has no scope", () => {
      const text = render(
        { operations: [{ operationId: "v1-get-storage-config", kind: "required" }] },
        catalogOf(),
        [oauthScheme],
      );

      expect(text).toContain("not available with OAuth tokens yet");
    });
  });

  describe("need", () => {
    it("tells required, maybe and optional apart", () => {
      const section = resolvePermissionSection(
        mapped({
          operations: [
            { operationId: "v1-list-all-projects", kind: "required" },
            { operationId: "v1-get-pooler-config", kind: "required", context: "a prompt picks it" },
            { operationId: "v1-get-project", kind: "best-effort", context: "a cache is cold" },
          ],
        }),
        catalogOf(),
      );

      expect(
        section?.status === "mapped" &&
          section.schemes[0]?.groups.map((group) => [group.heading, group.need]),
      ).toEqual([
        ["Required", "required"],
        ["May be required", "maybe"],
        ["Optional (command still runs without these)", "optional"],
      ]);
    });
  });

  describe("structured conditions", () => {
    const whenOf = (declaration: Declaration, catalog: FlagCatalog) => {
      const section = resolvePermissionSection(mapped(declaration), catalog);
      if (section?.status !== "mapped") throw new Error("expected a mapped section");
      return {
        shared: section.when,
        groups: section.schemes.flatMap((scheme) =>
          scheme.groups.map((group) => [group.heading, group.when] as const),
        ),
      };
    };

    it("gives each group the flag values it applies to, naming an unset or empty flag", () => {
      const { groups } = whenOf(
        {
          operations: [
            { operationId: "v1-list-all-projects", kind: "required" },
            {
              operationId: "v1-get-project",
              kind: "required",
              when: [{ flag: "dry", is: false }],
            },
            {
              operationId: "v1-get-pooler-config",
              kind: "required",
              when: [{ flag: "project-ref", present: false }],
            },
          ],
        },
        catalogOf(switchFlag("dry"), projectRef),
      );

      expect(groups).toEqual([
        ["Required", undefined],
        ["Required without --dry", [{ all: [{ flag: "dry", values: ["false"] }] }]],
        [
          "Required without --project-ref",
          [{ all: [{ flag: "project-ref", values: ["unset", "empty"] }] }],
        ],
      ]);
    });

    it("lists each way a group can apply as its own alternative", () => {
      const operation = { operationId: "v1-get-pooler-config", kind: "required" } as const;
      const { groups } = whenOf(
        {
          operations: [
            { operationId: "v1-list-all-projects", kind: "required" },
            { ...operation, when: [{ flag: "from", oneOf: ["linked"] }] },
            {
              ...operation,
              when: [
                { flag: "to", oneOf: ["linked"] },
                { flag: "dry", is: true },
              ],
            },
          ],
        },
        catalogOf(
          Flag.String("from").pipe(Flag.optional),
          Flag.String("to").pipe(Flag.optional),
          switchFlag("dry"),
        ),
      );

      expect(groups[1]?.[1]).toEqual([
        { all: [{ flag: "from", values: ["linked"] }] },
        {
          all: [
            { flag: "to", values: ["linked"] },
            { flag: "dry", values: ["true"] },
          ],
        },
      ]);
    });

    it("reports what holds for every group as one shared condition", () => {
      const { shared, groups } = whenOf(
        {
          operations: [
            {
              operationId: "v1-list-all-projects",
              kind: "required",
              when: [{ flag: "local", is: false }],
            },
            {
              operationId: "v1-get-project",
              kind: "best-effort",
              when: [{ flag: "local", is: false }],
            },
          ],
        },
        catalogOf(switchFlag("local")),
      );

      expect(shared).toEqual([{ flag: "local", values: ["false"] }]);
      expect(groups.map(([, when]) => when)).toEqual([undefined, undefined]);
    });

    it("names the linked project as the shared target when it is the default", () => {
      const { shared } = whenOf(
        {
          dbTargetDefault: "linked",
          operations: [
            {
              operationId: "v1-list-all-projects",
              kind: "required",
              when: [{ dbTarget: ["linked"] }],
            },
          ],
        },
        catalogOf(switchFlag("local"), switchFlag("linked")),
      );

      expect(shared).toEqual([{ target: ["linked"] }]);
    });

    it("keeps rows under different conditions apart even when the headings read alike", () => {
      const { groups } = whenOf(
        {
          operations: [
            { operationId: "v1-list-all-projects", kind: "required" },
            { operationId: "v1-get-project", kind: "required", when: [{ flag: "project-ref" }] },
            {
              operationId: "v1-get-pooler-config",
              kind: "required",
              when: [{ flag: "project-ref", oneOf: [""] }],
            },
          ],
        },
        catalogOf(projectRef),
      );

      expect(groups.slice(1)).toEqual([
        ["Required with --project-ref", [{ all: [{ flag: "project-ref", values: ["set"] }] }]],
        ['Required with --project-ref=""', [{ all: [{ flag: "project-ref", values: ["empty"] }] }]],
      ]);
    });

    it("treats naming a target flag as selecting that target", () => {
      const { groups } = whenOf(
        {
          dbTargetDefault: "local",
          operations: [
            { operationId: "v1-list-all-projects", kind: "required" },
            {
              operationId: "v1-get-project",
              kind: "required",
              when: [{ dbTarget: ["linked"] }],
            },
            {
              operationId: "v1-get-pooler-config",
              kind: "required",
              when: [{ flag: "linked", is: true }],
            },
          ],
        },
        catalogOf(switchFlag("local"), switchFlag("linked")),
      );

      expect(groups).toEqual([
        ["Required", undefined],
        ["Required with --linked", [{ all: [{ target: ["linked"] }] }]],
      ]);
    });

    it("names a target in a group's condition when not every entry depends on it", () => {
      const { shared, groups } = whenOf(
        {
          dbTargetDefault: "local",
          operations: [
            {
              operationId: "v1-list-all-projects",
              kind: "required",
              when: [{ dbTarget: ["linked"] }],
            },
            { operationId: "v1-get-project", kind: "required" },
          ],
        },
        catalogOf(switchFlag("local"), switchFlag("linked")),
      );

      expect(shared).toBeUndefined();
      expect(groups[1]).toEqual(["Required with --linked", [{ all: [{ target: ["linked"] }] }]]);
    });
  });

  describe("status", () => {
    it("says a command's permissions are not documented when it is unmapped", () => {
      const unmapped: CommandPermissions = { status: "unmapped", reason: "go-delegated" };
      const section = resolvePermissionSection(unmapped, catalogOf());

      expect(section).toEqual({ status: "unmapped" });
      expect(section && renderPermissionsSection(section)).toBe(
        lines("PERMISSIONS", "  Token permissions for this command are not documented yet."),
      );
    });

    it("shows nothing for a command that calls no API operation", () => {
      expect(render({ operations: [] })).toBeUndefined();
    });
  });
});
