import { describe, expect, it } from "vitest";
import { flattenLocalStackConfigParity } from "./local-stack-config-parity.ts";

describe("localStackConfigParity", () => {
  const entries = flattenLocalStackConfigParity();

  it("classifies every fixed project-config leaf exactly once", () => {
    const paths = entries.map(({ path }) => path);

    expect(paths).toHaveLength(373);
    expect(new Set(paths).size).toBe(paths.length);
    expect(
      Object.fromEntries(
        ["mapped", "not-applicable", "unsupported-blocking", "unsupported-warning"].map((tag) => [
          tag,
          entries.filter(({ decision }) => decision._tag === tag).length,
        ]),
      ),
    ).toEqual({
      mapped: 11,
      "not-applicable": 10,
      "unsupported-blocking": 346,
      "unsupported-warning": 6,
    });
  });

  it("claims only behavior implemented by a current next local-runtime flow as mapped", () => {
    expect(
      entries
        .filter(({ decision }) => decision._tag === "mapped")
        .map(({ path }) => path)
        .sort(),
    ).toEqual([
      "api.auto_expose_new_tables",
      "edge_runtime.enabled",
      "edge_runtime.inspector_port",
      "edge_runtime.policy",
      "edge_runtime.secrets",
      "functions.*",
      "functions.*.enabled",
      "functions.*.entrypoint",
      "functions.*.import_map",
      "functions.*.static_files",
      "functions.*.verify_jwt",
    ]);

    expect(
      entries.flatMap(({ path, decision }) =>
        decision._tag === "mapped" ? [`${decision.mappedBy}:${path}`] : [],
      ),
    ).toEqual([
      "start:api.auto_expose_new_tables",
      "functions-dev:edge_runtime.enabled",
      "functions-dev:edge_runtime.policy",
      "functions-dev:edge_runtime.inspector_port",
      "functions-dev:edge_runtime.secrets",
      "stack-functions-runtime:functions.*",
      "stack-functions-runtime:functions.*.enabled",
      "stack-functions-runtime:functions.*.verify_jwt",
      "stack-functions-runtime:functions.*.import_map",
      "stack-functions-runtime:functions.*.entrypoint",
      "stack-functions-runtime:functions.*.static_files",
    ]);
  });

  it("preserves presence requirements for presence-sensitive sections", () => {
    const byPath = new Map(entries.map(({ path, decision }) => [path, decision]));

    expect(byPath.get("api.auto_expose_new_tables")?.presence).toBe("raw-document");
    expect(byPath.get("auth.external.github.enabled")?.presence).toBe("enabled-subtree");
    expect(byPath.get("auth.external.github.client_id")?.presence).toBe("enabled-subtree");
    expect(byPath.get("auth.hook.send_email.enabled")?.presence).toBe("raw-document");
    expect(byPath.get("auth.sms.twilio.enabled")?.presence).toBe("enabled-subtree");
    expect(byPath.get("auth.oauth_server.enabled")?.presence).toBe("enabled-subtree");
    expect(byPath.get("auth.third_party.firebase.project_id")?.presence).toBe("enabled-subtree");
    expect(byPath.get("api.tls.cert_path")?.presence).toBe("enabled-subtree");
    expect(byPath.get("storage.analytics.max_tables")?.presence).toBe("enabled-subtree");
    expect(byPath.get("edge_runtime.deno_version")?.presence).toBe("non-default-value");
    expect(byPath.get("auth.jwt_secret")?.presence).toBe("effective-global-secret");
    expect(byPath.get("auth.external.*")?.presence).toBe("enabled-subtree");
    expect(byPath.get("storage.image_transformation.enabled")?.presence).toBe("raw-document");
    expect(byPath.get("storage.buckets.*")?.presence).toBe("raw-document");
    expect(byPath.get("storage.analytics.buckets.*")?.presence).toBe("enabled-subtree");
    expect(byPath.get("storage.vector.buckets.*")?.presence).toBe("enabled-subtree");
    expect(byPath.get("experimental.webhooks.enabled")?.presence).toBe("raw-document");
    expect(byPath.get("auth.external.apple.secret")?.presence).toBe("effective-secret");
    expect(byPath.get("studio.openai_api_key")?.presence).toBe("effective-secret");
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
