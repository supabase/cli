import type { CliConfig } from "@supabase/config";
import { describe, expect, it } from "vitest";
import { resolveMigrationChecksPolicy } from "./migration-checks-policy.ts";

const warnSeverities = {
  rls_disabled_in_public: "warn",
  rls_enabled_no_policy: "warn",
  policy_exists_rls_disabled: "warn",
  security_definer_view: "warn",
  rls_policy_always_true: "warn",
  sensitive_columns_exposed: "warn",
  auth_users_exposed: "warn",
  function_search_path_mutable: "warn",
  rls_references_user_metadata: "warn",
};

describe("resolveMigrationChecksPolicy", () => {
  it("defaults all nine rules to warn with no exclusions when checks is absent", () => {
    expect(resolveMigrationChecksPolicy(undefined)).toEqual({
      severities: warnSeverities,
      exclude: [],
    });
  });

  it("keeps explicit severities and fills only unset rules with warn", () => {
    const checks: CliConfig["db"]["migrations"]["checks"] = {
      rls_disabled_in_public: "error",
      rls_enabled_no_policy: "off",
    };

    expect(resolveMigrationChecksPolicy(checks)).toEqual({
      severities: {
        ...warnSeverities,
        rls_disabled_in_public: "error",
        rls_enabled_no_policy: "off",
      },
      exclude: [],
    });
  });

  it("flattens exclusions in rule order while keeping entry order", () => {
    const checks: CliConfig["db"]["migrations"]["checks"] = {
      exclude: {
        function_search_path_mutable: ["public.z_function", "public.a_function"],
        security_definer_view: [],
        rls_disabled_in_public: ["public.z_table", "public.a_table"],
      },
    };

    expect(resolveMigrationChecksPolicy(checks)).toEqual({
      severities: warnSeverities,
      exclude: [
        { rule: "rls_disabled_in_public", object: "public.z_table" },
        { rule: "rls_disabled_in_public", object: "public.a_table" },
        { rule: "function_search_path_mutable", object: "public.z_function" },
        { rule: "function_search_path_mutable", object: "public.a_function" },
      ],
    });
  });
});
