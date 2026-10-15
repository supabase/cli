import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

const repoRoot = fileURLToPath(new URL("../../../../", import.meta.url));
const oxlintBin = join(repoRoot, "node_modules/.bin/oxlint");
const pluginPath = join(repoRoot, "tools/oxlint/supabase-plugin.js");

const RULE_NAME = "no-raw-management-api-url";
const RULE = `supabase/${RULE_NAME}`;

const flagged = {
  "template-base.ts": "export const url = `${apiUrl}/v1/projects`;",
  "template-nested-path.ts": "export const url = `${apiUrl}/v2/projects/${ref}/config`;",
  "template-platform.ts": "export const url = `${apiUrl}/platform/cli/login/${id}`;",
  "template-absolute.ts": "export const url = `https://api.supabase.com/v1/projects/${ref}`;",
  "concatenation.ts": 'export const url = apiUrl + "/v1/projects";',
  "url-constructor.ts": 'export const url = new URL("/v1/projects", apiUrl);',
  "http-client-request.ts":
    'export const req = HttpClientRequest.get("https://api.supabase.com/v1/projects");',
  "fetch-call.ts": 'export const res = fetch("/v2/projects");',
  "client-method-literal.ts": 'export const res = client.get("/v1/profile");',
  "http-client-request-relative.ts": 'export const req = HttpClientRequest.get("/v1/projects");',
  "constant-path-concatenation.ts": [
    'const PROFILE_PATH = "/v1/profile";',
    "export const url = apiUrl + PROFILE_PATH;",
  ].join("\n"),
  "constant-path-template.ts": [
    'const PROFILE_PATH = "/v1/profile";',
    "export const url = `${apiUrl}${PROFILE_PATH}`;",
  ].join("\n"),
};

const allowed = {
  "service-rest.ts": "export const url = `${baseUrl}/rest/v1/`;",
  "service-auth.ts": "export const url = `${baseUrl}/auth/v1/health`;",
  "service-storage.ts": 'export const req = HttpClientRequest.get("/storage/v1/bucket");',
  "service-functions.ts": "export const url = `http://127.0.0.1:${port}/functions/v1/${name}`;",
  "studio-platform.ts": "export const url = `${studioUrl}/api/platform/profile`;",
  "otlp-traces-path.ts": 'export const OTLP_TRACES_PATH = "/v1/traces";',
  "unrelated-literal.ts": 'export const res = client.get("/health");',
  "version-lookalike.ts": 'export const label = "/v10/projects";',
  "documented-exception.ts": [
    `// oxlint-disable-next-line ${RULE} -- not in the OpenAPI spec`,
    "export const url = `${apiUrl}/platform/cli/login/${id}`;",
  ].join("\n"),
};

describe("no-raw-management-api-url", () => {
  let dir: string;
  let flaggedFiles: Set<string>;
  let lintedFiles: Set<string>;

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "supabase-lint-rule-"));
    mkdirSync(join(dir, "src"));
    writeFileSync(
      join(dir, ".oxlintrc.json"),
      JSON.stringify({
        jsPlugins: [pluginPath],
        categories: { correctness: "off" },
        rules: { [RULE]: "error" },
      }),
    );
    for (const [name, source] of Object.entries({ ...flagged, ...allowed })) {
      writeFileSync(join(dir, "src", name), `${source}\n`);
    }

    const result = spawnSync(
      oxlintBin,
      ["--config", join(dir, ".oxlintrc.json"), "--format", "json", join(dir, "src")],
      { encoding: "utf8" },
    );
    const report = JSON.parse(result.stdout) as {
      diagnostics: { filename: string; code: string }[];
      number_of_files: number;
    };
    flaggedFiles = new Set(
      report.diagnostics.filter((d) => d.code.includes(RULE_NAME)).map((d) => basename(d.filename)),
    );
    lintedFiles = new Set(Object.keys({ ...flagged, ...allowed }));
    expect(report.number_of_files).toBe(lintedFiles.size);
  });

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test.each(Object.keys(flagged))("flags %s", (name) => {
    expect(flaggedFiles.has(name)).toBe(true);
  });

  test.each(Object.keys(allowed))("allows %s", (name) => {
    expect(flaggedFiles.has(name)).toBe(false);
  });
});
