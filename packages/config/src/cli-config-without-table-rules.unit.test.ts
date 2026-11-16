import { Schema } from "effect";
import { describe, expect, test } from "vitest";
import { CliConfigSchema } from "./base.ts";
import {
  cliConfigExternalProviderIssues,
  cliConfigMigrationChecksIssues,
  cliConfigServiceVersionIssues,
  cliConfigSmsProviderIssues,
  cliConfigSmtpIssues,
  cliConfigStandIn,
  collectCliConfigEnvReferences,
  decodeCliConfigWithoutTableRules,
} from "./internal.ts";

const decodesFully = (document: unknown) =>
  Schema.decodeUnknownResult(CliConfigSchema)(document)._tag === "Success";

const decodeLeniently = (document: unknown) => {
  const result = decodeCliConfigWithoutTableRules(document);
  if (result._tag === "Failure") {
    throw new Error(`expected the rule-free decode to succeed: ${JSON.stringify(result.issues)}`);
  }
  return result.value;
};

describe("decodeCliConfigWithoutTableRules", () => {
  test("accepts documents the table rules would reject", () => {
    const documents = [
      { auth: { email: { smtp: { enabled: true } } } },
      { auth: { external: { github: { enabled: true } } } },
      { auth: { sms: { twilio: { enabled: true } } } },
      { local: { services: { database: { version: "1.0-r01" } } } },
      { db: { migrations: { checks: { rls_disabled_in_pubic: "error" } } } },
    ];
    for (const document of documents) {
      expect(decodesFully(document)).toBe(false);
      expect(decodeCliConfigWithoutTableRules(document)._tag).toBe("Success");
    }
  });

  test("still rejects leaf violations and reports every one", () => {
    const result = decodeCliConfigWithoutTableRules({
      compute: { api: { instances: -1 } },
      api: { max_rows: "many", db_extra_search_path: 3 },
    });
    expect(result._tag).toBe("Failure");
    if (result._tag === "Failure") {
      const paths = result.issues.map((issue) => issue.path.join("."));
      expect(paths).toContain("compute.api.instances");
      expect(paths.length).toBeGreaterThan(1);
    }
  });
});

describe("table rule checks", () => {
  const disabledSmtp = { enabled: false };

  const agree = (document: Record<string, unknown>, issueCount: number) => {
    expect(decodesFully(document)).toBe(issueCount === 0);
  };

  test("smtp", () => {
    const rejecting = { auth: { email: { smtp: { enabled: true, host: "h" } } } };
    const smtp = decodeLeniently(rejecting).auth.email.smtp ?? disabledSmtp;
    const issues = cliConfigSmtpIssues(smtp);
    expect(issues.map((issue) => issue.path)).toEqual([
      ["port"],
      ["user"],
      ["pass"],
      ["admin_email"],
    ]);
    agree(rejecting, issues.length);
    const accepting = { auth: { email: { smtp: { enabled: false } } } };
    agree(
      accepting,
      cliConfigSmtpIssues(decodeLeniently(accepting).auth.email.smtp ?? disabledSmtp).length,
    );
  });

  test("external providers", () => {
    const rejecting = { auth: { external: { github: { enabled: true, client_id: "id" } } } };
    const github = decodeLeniently(rejecting).auth.external.github;
    const issues = cliConfigExternalProviderIssues("github", github);
    expect(issues).toEqual([
      {
        path: ["secret"],
        message: "Missing required field in config: auth.external.github.secret",
      },
    ]);
    agree(rejecting, issues.length);
    const google = { auth: { external: { google: { enabled: true, client_id: "id" } } } };
    agree(
      google,
      cliConfigExternalProviderIssues("google", decodeLeniently(google).auth.external.google)
        .length,
    );
  });

  test("sms provider switch", () => {
    const rejecting = { auth: { sms: { twilio: { enabled: true } } } };
    const issues = cliConfigSmsProviderIssues(decodeLeniently(rejecting).auth.sms);
    expect(issues[0]?.path).toEqual(["twilio", "account_sid"]);
    agree(rejecting, issues.length);
    const accepting = { auth: { sms: { messagebird: { enabled: false } } } };
    agree(accepting, cliConfigSmsProviderIssues(decodeLeniently(accepting).auth.sms).length);
  });

  test("service versions report every bad service", () => {
    const rejecting = {
      local: {
        services: {
          database: { version: "1.0-r01" },
          auth: { version: "default" },
          rest: { version: "bundled" },
        },
      },
    };
    const services = decodeLeniently(rejecting).local?.services;
    const issues = cliConfigServiceVersionIssues(services ?? {});
    expect(issues.map((issue) => issue.path)).toEqual([
      ["database", "version"],
      ["auth", "version"],
    ]);
    agree(rejecting, issues.length);
    const accepting = { local: { services: { database: { version: "17.6.1.200-orioledb" } } } };
    agree(
      accepting,
      cliConfigServiceVersionIssues(decodeLeniently(accepting).local?.services ?? {}).length,
    );
  });

  test("migration checks run on the raw table", () => {
    const raw = { rls_disabled_in_pubic: "error", rls_enabled_no_policy: "warn" };
    const issues = cliConfigMigrationChecksIssues(raw);
    expect(issues.map((issue) => issue.path)).toEqual([["rls_disabled_in_pubic"]]);
    agree({ db: { migrations: { checks: raw } } }, issues.length);
    const valid = { rls_disabled_in_public: "off" };
    agree({ db: { migrations: { checks: valid } } }, cliConfigMigrationChecksIssues(valid).length);
  });
});

describe("decodeCliConfigWithoutTableRules cliCompat", () => {
  const document = { db: { network_restrictions: { allowed_cidrs: "10.0.0.0/8,192.168.0.0/16" } } };

  test("splits a literal comma string at an array path only under cliCompat", () => {
    expect(decodeCliConfigWithoutTableRules(document)._tag).toBe("Failure");
    const result = decodeCliConfigWithoutTableRules(document, { cliCompat: true });
    expect(result._tag).toBe("Success");
    if (result._tag === "Success") {
      expect(result.value.db.network_restrictions.allowed_cidrs).toEqual([
        "10.0.0.0/8",
        "192.168.0.0/16",
      ]);
    }
  });
});

describe("collectCliConfigEnvReferences", () => {
  test("finds env() leaves and skips deferred functions.<name>.env fields", () => {
    expect(
      collectCliConfigEnvReferences({
        project_id: "env(PROJECT)",
        functions: { hello: { env: { KEY: "env(SECRET)" } } },
      }),
    ).toEqual([{ path: ["project_id"], name: "PROJECT" }]);
  });

  test("finds references inside a remotes block", () => {
    expect(
      collectCliConfigEnvReferences({ remotes: { prod: { project_id: "env(PROD_REF)" } } }),
    ).toEqual([{ path: ["remotes", "prod", "project_id"], name: "PROD_REF" }]);
  });

  test("reports array elements at the array key, once per name", () => {
    expect(
      collectCliConfigEnvReferences({
        db: { seed: { sql_paths: ["env(A)", "./x.sql", "env(B)", "env(A)"] } },
      }),
    ).toEqual([
      { path: ["db", "seed", "sql_paths"], name: "A" },
      { path: ["db", "seed", "sql_paths"], name: "B" },
    ]);
  });
});

describe("collectCliConfigEnvReferences nesting", () => {
  test("reports references in nested arrays and tables inside arrays at the outermost array", () => {
    expect(
      collectCliConfigEnvReferences({
        db: { seed: { sql_paths: [["env(A)"], [{ k: "env(B)" }]] } },
      }),
    ).toEqual([
      { path: ["db", "seed", "sql_paths"], name: "A" },
      { path: ["db", "seed", "sql_paths"], name: "B" },
    ]);
  });
});

describe("cliConfigStandIn", () => {
  test("derives a typed placeholder from the schema leaf", () => {
    expect(cliConfigStandIn(["project_id"])).toBe("");
    expect(cliConfigStandIn(["api", "port"])).toBe(0);
    expect(cliConfigStandIn(["api", "enabled"])).toBe(false);
    expect(cliConfigStandIn(["db", "seed", "sql_paths"])).toEqual([]);
    expect(cliConfigStandIn(["db", "network_restrictions"])).toEqual({});
    expect(cliConfigStandIn(["remotes", "prod"])).toEqual({});
    expect(cliConfigStandIn(["db", "major_version"])).toBeTypeOf("number");
  });

  test("returns undefined for a path that does not resolve", () => {
    expect(cliConfigStandIn(["nope", "missing"])).toBeUndefined();
  });
});
