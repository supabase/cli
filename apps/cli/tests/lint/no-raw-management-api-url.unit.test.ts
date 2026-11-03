import { BunServices } from "@effect/platform-bun";
import { Effect, FileSystem, Path, Schema } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

const repoRoot = fileURLToPath(new URL("../../../../", import.meta.url));

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

const LintReport = Schema.Struct({
  diagnostics: Schema.Array(Schema.Struct({ filename: Schema.String, code: Schema.String })),
  number_of_files: Schema.Finite,
});
const encodeJson = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));
const decodeLintReport = Schema.decodeUnknownEffect(Schema.fromJsonString(LintReport));

describe("no-raw-management-api-url", () => {
  let dir: string;
  let flaggedFiles: Set<string>;
  let lintedFiles: Set<string>;

  beforeAll(() =>
    Effect.runPromise(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
        const oxlintBin = path.join(repoRoot, "node_modules/.bin/oxlint");
        const pluginPath = path.join(repoRoot, "tools/oxlint/supabase-plugin.js");
        dir = yield* fs.makeTempDirectory({ prefix: "supabase-lint-rule-" });
        yield* fs.makeDirectory(path.join(dir, "src"));
        yield* fs.writeFileString(
          path.join(dir, ".oxlintrc.json"),
          yield* encodeJson({
            jsPlugins: [pluginPath],
            categories: { correctness: "off" },
            rules: { [RULE]: "error" },
          }),
        );
        for (const [name, source] of Object.entries({ ...flagged, ...allowed })) {
          yield* fs.writeFileString(path.join(dir, "src", name), `${source}\n`);
        }

        const stdout = yield* spawner.string(
          ChildProcess.make(
            oxlintBin,
            [
              "--config",
              path.join(dir, ".oxlintrc.json"),
              "--format",
              "json",
              path.join(dir, "src"),
            ],
            /* A plain child, not a process group: no process-group signals. */
            { detached: false, stdin: "ignore", stderr: "ignore" },
          ),
        );
        const report = yield* decodeLintReport(stdout);
        flaggedFiles = new Set(
          report.diagnostics
            .filter((d) => d.code.includes(RULE_NAME))
            .map((d) => path.basename(d.filename)),
        );
        lintedFiles = new Set(Object.keys({ ...flagged, ...allowed }));
        expect(report.number_of_files).toBe(lintedFiles.size);
      }).pipe(Effect.provide(BunServices.layer)),
    ),
  );

  afterAll(() =>
    Effect.runPromise(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        yield* fs.remove(dir, { recursive: true, force: true });
      }).pipe(Effect.provide(BunServices.layer)),
    ),
  );

  test.each(Object.keys(flagged))("flags %s", (name) => {
    expect(flaggedFiles.has(name)).toBe(true);
  });

  test.each(Object.keys(allowed))("allows %s", (name) => {
    expect(flaggedFiles.has(name)).toBe(false);
  });
});
