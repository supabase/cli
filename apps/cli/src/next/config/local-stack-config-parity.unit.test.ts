import { describe, expect, it } from "vitest";
import { flattenLocalStackConfigParity } from "./local-stack-config-parity.ts";

describe("localStackConfigParity", () => {
  const entries = flattenLocalStackConfigParity();

  it("classifies every fixed project-config leaf exactly once", () => {
    const paths = entries.map(({ path }) => path);

    expect(paths).toHaveLength(361);
    expect(new Set(paths).size).toBe(paths.length);
    expect(
      Object.fromEntries(
        ["mapped", "not-applicable", "unsupported-blocking", "unsupported-warning"].map((tag) => [
          tag,
          entries.filter(({ decision }) => decision._tag === tag).length,
        ]),
      ),
    ).toEqual({
      mapped: 247,
      "not-applicable": 10,
      "unsupported-blocking": 98,
      "unsupported-warning": 6,
    });
  });

  it("maps core topology and Auth while leaving unimplemented domains explicit", () => {
    const mappedPaths = entries
      .filter(({ decision }) => decision._tag === "mapped")
      .map(({ path }) => path);

    expect(mappedPaths.filter((path) => !path.startsWith("auth.")).sort()).toEqual([
      "analytics.backend",
      "analytics.enabled",
      "analytics.port",
      "api.auto_expose_new_tables",
      "api.enabled",
      "api.extra_search_path",
      "api.max_rows",
      "api.port",
      "api.schemas",
      "db.health_timeout",
      "db.pooler.default_pool_size",
      "db.pooler.enabled",
      "db.pooler.max_client_conn",
      "db.pooler.pool_mode",
      "db.pooler.port",
      "db.port",
      "edge_runtime.enabled",
      "edge_runtime.inspector_port",
      "edge_runtime.policy",
      "edge_runtime.secrets",
      "functions.*.enabled",
      "functions.*.entrypoint",
      "functions.*.env",
      "functions.*.import_map",
      "functions.*.static_files",
      "functions.*.verify_jwt",
      "local_smtp.admin_email",
      "local_smtp.enabled",
      "local_smtp.pop3_port",
      "local_smtp.port",
      "local_smtp.sender_name",
      "local_smtp.smtp_port",
      "realtime.enabled",
      "realtime.max_header_length",
      "storage.enabled",
      "storage.file_size_limit",
      "storage.image_transformation.enabled",
      "storage.s3_protocol.enabled",
      "studio.api_url",
      "studio.enabled",
      "studio.port",
    ]);
    expect(mappedPaths.filter((path) => path.startsWith("auth."))).toHaveLength(206);
    expect(mappedPaths).toEqual(
      expect.arrayContaining([
        "auth.enabled",
        "auth.signing_keys_path",
        "auth.email.smtp.pass",
        "auth.sms.twilio.auth_token",
        "auth.external.github.redirect_uri",
        "auth.hook.custom_access_token.secrets",
      ]),
    );
    expect(mappedPaths).not.toEqual(
      expect.arrayContaining([
        "auth.email.template.*.content_path",
        "auth.mfa.totp.enroll_enabled",
        "auth.rate_limit.email_sent",
      ]),
    );
  });

  it("preserves raw-document requirements for presence-sensitive sections", () => {
    const byPath = new Map(entries.map(({ path, decision }) => [path, decision]));

    expect(byPath.get("api.auto_expose_new_tables")?.presence).toBe("raw-document");
    expect(byPath.get("auth.external.github.enabled")?.presence).toBe("raw-document");
    expect(byPath.get("auth.hook.send_email.enabled")?.presence).toBe("raw-document");
    expect(byPath.get("auth.sms.twilio.enabled")?.presence).toBe("raw-document");
    expect(byPath.get("storage.image_transformation.enabled")?.presence).toBe("raw-document");
    expect(byPath.get("experimental.webhooks.enabled")?.presence).toBe("raw-document");
  });

  it("keeps non-runtime project configuration out of StackConfig", () => {
    expect(
      entries
        .filter(({ decision }) => decision._tag === "not-applicable")
        .map(({ path }) => path)
        .sort(),
    ).toEqual([
      "db.network_restrictions.allowed_cidrs",
      "db.network_restrictions.allowed_cidrs_v6",
      "db.network_restrictions.enabled",
      "db.shadow_port",
      "experimental.inspect.rules",
      "experimental.pgdelta.declarative_schema_path",
      "experimental.pgdelta.enabled",
      "experimental.pgdelta.format_options",
      "project_id",
      "remotes",
    ]);
  });
});
