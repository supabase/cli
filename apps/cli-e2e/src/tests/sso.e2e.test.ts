import { BunFileSystem, BunPath } from "@effect/platform-bun";
import { describe, expect } from "vitest";
import { Effect, FileSystem, Layer, Path, Schema } from "effect";
import { FetchHttpClient, HttpClient, HttpClientRequest, HttpMethod } from "effect/unstable/http";
import { isRecording, PROJECT_REF, PROVIDER_ID } from "./env.ts";
import { testBehaviour } from "./test-context.ts";

const MINIMAL_SAML_XML = `<?xml version="1.0" encoding="UTF-8"?>
<md:EntityDescriptor xmlns:md="urn:oasis:names:tc:SAML:2.0:metadata" entityID="https://example.com/saml">
  <md:IDPSSODescriptor WantAuthnRequestsSigned="false" protocolSupportEnumeration="urn:oasis:names:tc:SAML:2.0:protocol">
    <md:SingleSignOnService Binding="urn:oasis:names:tc:SAML:2.0:bindings:HTTP-POST" Location="https://example.com/saml/sso"/>
  </md:IDPSSODescriptor>
</md:EntityDescriptor>`;

const testLayer = Layer.mergeAll(FetchHttpClient.layer, BunFileSystem.layer, BunPath.layer);

const parseJson = (input: string) =>
  Schema.decodeEffect(Schema.fromJsonString(Schema.Unknown))(input);

interface HttpRequestOptions extends Omit<RequestInit, "body"> {
  readonly body?: unknown;
}

function httpRequest(input: string, init: HttpRequestOptions): Promise<Response> {
  return Effect.runPromise(
    Effect.gen(function* () {
      const method = init.method ?? "GET";
      if (!HttpMethod.isHttpMethod(method)) {
        return yield* Effect.die(new Error(`Unsupported HTTP method: ${method}`));
      }
      let request = HttpClientRequest.make(method)(input, {
        headers: init.headers === undefined ? {} : new globalThis.Headers(init.headers),
      });
      if (init.body !== undefined) {
        request = yield* HttpClientRequest.bodyJson(request, init.body);
      }
      const response = yield* HttpClient.execute(request);
      const body = yield* response.arrayBuffer;
      return new Response(body, { status: response.status, headers: { ...response.headers } });
    }).pipe(Effect.provide(FetchHttpClient.layer), Effect.orDie),
  );
}

const writeMetadataFile = (workspacePath: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const metadataPath = path.join(workspacePath, "saml.xml");
    yield* fs.writeFileString(metadataPath, MINIMAL_SAML_XML);
    return metadataPath;
  });

describe("sso", () => {
  describe("sso:list", () => {
    testBehaviour("renders fixture data in output", ({ run, projectRef }) =>
      Effect.runPromise(
        Effect.gen(function* () {
          const result = yield* Effect.promise(() =>
            run(["sso", "list", "--project-ref", projectRef]),
          );
          expect(result.exitCode).toBe(0);
          expect(result.stdout).toContain("IDENTITY PROVIDER ID");
        }).pipe(Effect.provide(testLayer), Effect.orDie),
      ),
    );

    testBehaviour("returns json output with --output json", ({ run, projectRef }) =>
      Effect.runPromise(
        Effect.gen(function* () {
          const result = yield* Effect.promise(() =>
            run(["sso", "list", "--output", "json", "--project-ref", projectRef]),
          );
          expect(result.exitCode).toBe(0);
          expect(yield* parseJson(result.stdout)).toMatchObject({ providers: [] });
        }).pipe(Effect.provide(testLayer), Effect.orDie),
      ),
    );

    testBehaviour("includes debug output with --debug", ({ run, projectRef }) =>
      Effect.runPromise(
        Effect.gen(function* () {
          const result = yield* Effect.promise(() =>
            run(["sso", "list", "--debug", "--project-ref", projectRef]),
          );
          expect(result.exitCode).toBe(0);
          expect(result.stderr).toMatch(/HTTP.*GET:/);
        }).pipe(Effect.provide(testLayer), Effect.orDie),
      ),
    );

    testBehaviour("exits non-zero on 401", ({ run, apiUrl }) =>
      Effect.runPromise(
        Effect.gen(function* () {
          yield* Effect.promise(() =>
            httpRequest(`${apiUrl}/_ctrl/error-all`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: { status: 401, body: { message: "Invalid token" } },
            }),
          );
          const result = yield* Effect.promise(() =>
            run(["sso", "list", "--project-ref", PROJECT_REF]),
          );
          expect(result.exitCode).not.toBe(0);
          expect(result.stderr).toContain("Invalid token");
        }).pipe(Effect.provide(testLayer), Effect.orDie),
      ),
    );

    testBehaviour("exits non-zero on 403", ({ run, apiUrl }) =>
      Effect.runPromise(
        Effect.gen(function* () {
          yield* Effect.promise(() =>
            httpRequest(`${apiUrl}/_ctrl/error-all`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: { status: 403, body: { message: "Forbidden" } },
            }),
          );
          const result = yield* Effect.promise(() =>
            run(["sso", "list", "--project-ref", PROJECT_REF]),
          );
          expect(result.exitCode).not.toBe(0);
          expect(result.stderr).toContain("Forbidden");
        }).pipe(Effect.provide(testLayer), Effect.orDie),
      ),
    );

    testBehaviour("exits non-zero on 404 project not found", ({ run, apiUrl }) =>
      Effect.runPromise(
        Effect.gen(function* () {
          yield* Effect.promise(() =>
            httpRequest(`${apiUrl}/_ctrl/error-all`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: { status: 404, body: { message: "Project not found" } },
            }),
          );
          const result = yield* Effect.promise(() =>
            run(["sso", "list", "--project-ref", PROJECT_REF]),
          );
          expect(result.exitCode).not.toBe(0);
          expect(result.stderr).toContain("SAML 2.0 support is not enabled");
        }).pipe(Effect.provide(testLayer), Effect.orDie),
      ),
    );

    testBehaviour("exits non-zero on 429", ({ run, apiUrl }) =>
      Effect.runPromise(
        Effect.gen(function* () {
          yield* Effect.promise(() =>
            httpRequest(`${apiUrl}/_ctrl/error-all`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: { status: 429, body: { message: "Too Many Requests" } },
            }),
          );
          const result = yield* Effect.promise(() =>
            run(["sso", "list", "--project-ref", PROJECT_REF]),
          );
          expect(result.exitCode).not.toBe(0);
          expect(result.stderr).toContain("Too Many Requests");
        }).pipe(Effect.provide(testLayer), Effect.orDie),
      ),
    );

    testBehaviour("exits non-zero on 500", ({ run, apiUrl }) =>
      Effect.runPromise(
        Effect.gen(function* () {
          yield* Effect.promise(() =>
            httpRequest(`${apiUrl}/_ctrl/error-all`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: { status: 500, body: { message: "Internal Server Error" } },
            }),
          );
          const result = yield* Effect.promise(() =>
            run(["sso", "list", "--project-ref", PROJECT_REF]),
          );
          expect(result.exitCode).not.toBe(0);
          expect(result.stderr).toContain("Internal Server Error");
        }).pipe(Effect.provide(testLayer), Effect.orDie),
      ),
    );
  });

  describe("sso:info", () => {
    testBehaviour("renders fixture data in output", ({ run, projectRef }) =>
      Effect.runPromise(
        Effect.gen(function* () {
          const result = yield* Effect.promise(() =>
            run(["sso", "info", "--project-ref", projectRef]),
          );
          expect(result.exitCode).toBe(0);
          expect(result.stdout).toContain("supabase.co/auth/v1/sso/saml/acs");
        }).pipe(Effect.provide(testLayer), Effect.orDie),
      ),
    );

    testBehaviour("returns json output with --output json", ({ run, projectRef }) =>
      Effect.runPromise(
        Effect.gen(function* () {
          const result = yield* Effect.promise(() =>
            run(["sso", "info", "--output", "json", "--project-ref", projectRef]),
          );
          expect(result.exitCode).toBe(0);
          expect(yield* parseJson(result.stdout)).toMatchObject({
            acs_url: expect.stringContaining("supabase.co/auth/v1/sso/saml/acs"),
          });
        }).pipe(Effect.provide(testLayer), Effect.orDie),
      ),
    );

    // sso info makes no API calls — no error injection tests needed
  });

  describe("sso:show", () => {
    testBehaviour.skipIf(isRecording)("renders fixture data in output", ({ run, projectRef }) =>
      Effect.runPromise(
        Effect.gen(function* () {
          const result = yield* Effect.promise(() =>
            run(["sso", "show", PROVIDER_ID, "--project-ref", projectRef]),
          );
          expect(result.exitCode).toBe(0);
          expect(result.stdout).toContain("example.com");
        }).pipe(Effect.provide(testLayer), Effect.orDie),
      ),
    );

    testBehaviour.skipIf(isRecording)(
      "returns json output with --output json",
      ({ run, projectRef }) =>
        Effect.runPromise(
          Effect.gen(function* () {
            const result = yield* Effect.promise(() =>
              run(["sso", "show", PROVIDER_ID, "--output", "json", "--project-ref", projectRef]),
            );
            expect(result.exitCode).toBe(0);
            expect(result.stdout).toContain("example.com");
          }).pipe(Effect.provide(testLayer), Effect.orDie),
        ),
    );

    testBehaviour.skipIf(isRecording)(
      "shows raw SAML metadata XML with --metadata",
      ({ run, projectRef }) =>
        Effect.runPromise(
          Effect.gen(function* () {
            const result = yield* Effect.promise(() =>
              run(["sso", "show", PROVIDER_ID, "--metadata", "--project-ref", projectRef]),
            );
            expect(result.exitCode).toBe(0);
            expect(result.stdout).toContain("EntityDescriptor");
          }).pipe(Effect.provide(testLayer), Effect.orDie),
        ),
    );

    testBehaviour("exits non-zero on 401", ({ run, apiUrl }) =>
      Effect.runPromise(
        Effect.gen(function* () {
          yield* Effect.promise(() =>
            httpRequest(`${apiUrl}/_ctrl/error-all`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: { status: 401, body: { message: "Invalid token" } },
            }),
          );
          const result = yield* Effect.promise(() =>
            run(["sso", "show", PROVIDER_ID, "--project-ref", PROJECT_REF]),
          );
          expect(result.exitCode).not.toBe(0);
          expect(result.stderr).toContain("Invalid token");
        }).pipe(Effect.provide(testLayer), Effect.orDie),
      ),
    );

    testBehaviour("exits non-zero on 403", ({ run, apiUrl }) =>
      Effect.runPromise(
        Effect.gen(function* () {
          yield* Effect.promise(() =>
            httpRequest(`${apiUrl}/_ctrl/error-all`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: { status: 403, body: { message: "Forbidden" } },
            }),
          );
          const result = yield* Effect.promise(() =>
            run(["sso", "show", PROVIDER_ID, "--project-ref", PROJECT_REF]),
          );
          expect(result.exitCode).not.toBe(0);
          expect(result.stderr).toContain("Forbidden");
        }).pipe(Effect.provide(testLayer), Effect.orDie),
      ),
    );

    testBehaviour("exits non-zero on 404 provider not found", ({ run, apiUrl }) =>
      Effect.runPromise(
        Effect.gen(function* () {
          yield* Effect.promise(() =>
            httpRequest(`${apiUrl}/_ctrl/error-all`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: { status: 404, body: { message: "SSO Identity Provider not found" } },
            }),
          );
          const result = yield* Effect.promise(() =>
            run(["sso", "show", PROVIDER_ID, "--project-ref", PROJECT_REF]),
          );
          expect(result.exitCode).not.toBe(0);
          expect(result.stderr).toContain("could not be found");
        }).pipe(Effect.provide(testLayer), Effect.orDie),
      ),
    );

    testBehaviour("exits non-zero on 429", ({ run, apiUrl }) =>
      Effect.runPromise(
        Effect.gen(function* () {
          yield* Effect.promise(() =>
            httpRequest(`${apiUrl}/_ctrl/error-all`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: { status: 429, body: { message: "Too Many Requests" } },
            }),
          );
          const result = yield* Effect.promise(() =>
            run(["sso", "show", PROVIDER_ID, "--project-ref", PROJECT_REF]),
          );
          expect(result.exitCode).not.toBe(0);
          expect(result.stderr).toContain("Too Many Requests");
        }).pipe(Effect.provide(testLayer), Effect.orDie),
      ),
    );

    testBehaviour("exits non-zero on 500", ({ run, apiUrl }) =>
      Effect.runPromise(
        Effect.gen(function* () {
          yield* Effect.promise(() =>
            httpRequest(`${apiUrl}/_ctrl/error-all`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: { status: 500, body: { message: "Internal Server Error" } },
            }),
          );
          const result = yield* Effect.promise(() =>
            run(["sso", "show", PROVIDER_ID, "--project-ref", PROJECT_REF]),
          );
          expect(result.exitCode).not.toBe(0);
          expect(result.stderr).toContain("Internal Server Error");
        }).pipe(Effect.provide(testLayer), Effect.orDie),
      ),
    );
  });

  describe("sso:add", () => {
    testBehaviour("adds SAML provider via metadata file", ({ run, projectRef, workspace }) =>
      Effect.runPromise(
        Effect.gen(function* () {
          const metadataPath = yield* writeMetadataFile(workspace.path);
          const result = yield* Effect.promise(() =>
            run([
              "sso",
              "add",
              "--type",
              "saml",
              "--metadata-file",
              metadataPath,
              "--domains",
              "example.com",
              "--project-ref",
              projectRef,
            ]),
          );
          expect(result.exitCode).toBe(0);
          expect(result.stdout).toContain("example.com");
        }).pipe(Effect.provide(testLayer), Effect.orDie),
      ),
    );

    testBehaviour("exits non-zero without --type", ({ run }) =>
      Effect.runPromise(
        Effect.gen(function* () {
          const result = yield* Effect.promise(() =>
            run([
              "sso",
              "add",
              "--metadata-url",
              "https://example.com/saml/metadata",
              "--skip-url-validation",
              "--project-ref",
              PROJECT_REF,
            ]),
          );
          expect(result.exitCode).not.toBe(0);
          expect(result.stderr).toContain('"type"');
        }).pipe(Effect.provide(testLayer), Effect.orDie),
      ),
    );

    testBehaviour(
      "exits non-zero with both --metadata-url and --metadata-file",
      ({ run, workspace }) =>
        Effect.runPromise(
          Effect.gen(function* () {
            const metadataPath = yield* writeMetadataFile(workspace.path);
            const result = yield* Effect.promise(() =>
              run([
                "sso",
                "add",
                "--type",
                "saml",
                "--metadata-url",
                "https://example.com/saml/metadata",
                "--metadata-file",
                metadataPath,
                "--project-ref",
                PROJECT_REF,
              ]),
            );
            expect(result.exitCode).not.toBe(0);
            expect(result.stderr).toContain("metadata");
          }).pipe(Effect.provide(testLayer), Effect.orDie),
        ),
    );

    testBehaviour("exits non-zero with unreachable --metadata-url", ({ run }) =>
      Effect.runPromise(
        Effect.gen(function* () {
          const result = yield* Effect.promise(() =>
            run([
              "sso",
              "add",
              "--type",
              "saml",
              "--metadata-url",
              "http://localhost:19999/saml.xml",
              "--project-ref",
              PROJECT_REF,
            ]),
          );
          expect(result.exitCode).not.toBe(0);
          expect(result.stderr).toContain("HTTPS");
        }).pipe(Effect.provide(testLayer), Effect.orDie),
      ),
    );

    testBehaviour("exits non-zero on 401", ({ run, apiUrl, workspace }) =>
      Effect.runPromise(
        Effect.gen(function* () {
          const metadataPath = yield* writeMetadataFile(workspace.path);
          yield* Effect.promise(() =>
            httpRequest(`${apiUrl}/_ctrl/error-all`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: { status: 401, body: { message: "Invalid token" } },
            }),
          );
          const result = yield* Effect.promise(() =>
            run([
              "sso",
              "add",
              "--type",
              "saml",
              "--metadata-file",
              metadataPath,
              "--project-ref",
              PROJECT_REF,
            ]),
          );
          expect(result.exitCode).not.toBe(0);
          expect(result.stderr).toContain("Invalid token");
        }).pipe(Effect.provide(testLayer), Effect.orDie),
      ),
    );

    testBehaviour("exits non-zero on 403", ({ run, apiUrl, workspace }) =>
      Effect.runPromise(
        Effect.gen(function* () {
          const metadataPath = yield* writeMetadataFile(workspace.path);
          yield* Effect.promise(() =>
            httpRequest(`${apiUrl}/_ctrl/error-all`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: { status: 403, body: { message: "Forbidden" } },
            }),
          );
          const result = yield* Effect.promise(() =>
            run([
              "sso",
              "add",
              "--type",
              "saml",
              "--metadata-file",
              metadataPath,
              "--project-ref",
              PROJECT_REF,
            ]),
          );
          expect(result.exitCode).not.toBe(0);
          expect(result.stderr).toContain("Forbidden");
        }).pipe(Effect.provide(testLayer), Effect.orDie),
      ),
    );

    testBehaviour("exits non-zero on 422 invalid metadata", ({ run, apiUrl, workspace }) =>
      Effect.runPromise(
        Effect.gen(function* () {
          const metadataPath = yield* writeMetadataFile(workspace.path);
          yield* Effect.promise(() =>
            httpRequest(`${apiUrl}/_ctrl/error-all`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: {
                status: 422,
                body: { message: "Invalid SAML metadata" },
              },
            }),
          );
          const result = yield* Effect.promise(() =>
            run([
              "sso",
              "add",
              "--type",
              "saml",
              "--metadata-file",
              metadataPath,
              "--project-ref",
              PROJECT_REF,
            ]),
          );
          expect(result.exitCode).not.toBe(0);
          expect(result.stderr).toContain("Invalid SAML metadata");
        }).pipe(Effect.provide(testLayer), Effect.orDie),
      ),
    );

    testBehaviour("exits non-zero on 429", ({ run, apiUrl, workspace }) =>
      Effect.runPromise(
        Effect.gen(function* () {
          const metadataPath = yield* writeMetadataFile(workspace.path);
          yield* Effect.promise(() =>
            httpRequest(`${apiUrl}/_ctrl/error-all`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: { status: 429, body: { message: "Too Many Requests" } },
            }),
          );
          const result = yield* Effect.promise(() =>
            run([
              "sso",
              "add",
              "--type",
              "saml",
              "--metadata-file",
              metadataPath,
              "--project-ref",
              PROJECT_REF,
            ]),
          );
          expect(result.exitCode).not.toBe(0);
          expect(result.stderr).toContain("Too Many Requests");
        }).pipe(Effect.provide(testLayer), Effect.orDie),
      ),
    );

    testBehaviour("exits non-zero on 500", ({ run, apiUrl, workspace }) =>
      Effect.runPromise(
        Effect.gen(function* () {
          const metadataPath = yield* writeMetadataFile(workspace.path);
          yield* Effect.promise(() =>
            httpRequest(`${apiUrl}/_ctrl/error-all`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: { status: 500, body: { message: "Internal Server Error" } },
            }),
          );
          const result = yield* Effect.promise(() =>
            run([
              "sso",
              "add",
              "--type",
              "saml",
              "--metadata-file",
              metadataPath,
              "--project-ref",
              PROJECT_REF,
            ]),
          );
          expect(result.exitCode).not.toBe(0);
          expect(result.stderr).toContain("Internal Server Error");
        }).pipe(Effect.provide(testLayer), Effect.orDie),
      ),
    );
  });

  describe("sso:update", () => {
    testBehaviour.skipIf(isRecording)("appends domain with --add-domains", ({ run, projectRef }) =>
      Effect.runPromise(
        Effect.gen(function* () {
          const result = yield* Effect.promise(() =>
            run([
              "sso",
              "update",
              PROVIDER_ID,
              "--add-domains",
              "example.com",
              "--project-ref",
              projectRef,
            ]),
          );
          expect(result.exitCode).toBe(0);
          expect(result.stdout).toContain("example.com");
        }).pipe(Effect.provide(testLayer), Effect.orDie),
      ),
    );

    testBehaviour.skipIf(isRecording)("replaces domains with --domains", ({ run, projectRef }) =>
      Effect.runPromise(
        Effect.gen(function* () {
          const result = yield* Effect.promise(() =>
            run([
              "sso",
              "update",
              PROVIDER_ID,
              "--domains",
              "new.com",
              "--project-ref",
              projectRef,
            ]),
          );
          expect(result.exitCode).toBe(0);
          expect(result.stdout).toContain("new.com");
        }).pipe(Effect.provide(testLayer), Effect.orDie),
      ),
    );

    testBehaviour.skipIf(isRecording)(
      "removes domain with --remove-domains",
      ({ run, projectRef }) =>
        Effect.runPromise(
          Effect.gen(function* () {
            const result = yield* Effect.promise(() =>
              run([
                "sso",
                "update",
                PROVIDER_ID,
                "--remove-domains",
                "example.com",
                "--project-ref",
                projectRef,
              ]),
            );
            expect(result.exitCode).toBe(0);
            expect(result.stdout).toContain("IDENTITY PROVIDER ID");
          }).pipe(Effect.provide(testLayer), Effect.orDie),
        ),
    );

    testBehaviour.skipIf(isRecording)(
      "updates metadata via metadata file",
      ({ run, projectRef, workspace }) =>
        Effect.runPromise(
          Effect.gen(function* () {
            const metadataPath = yield* writeMetadataFile(workspace.path);
            const result = yield* Effect.promise(() =>
              run([
                "sso",
                "update",
                PROVIDER_ID,
                "--metadata-file",
                metadataPath,
                "--project-ref",
                projectRef,
              ]),
            );
            expect(result.exitCode).toBe(0);
            expect(result.stdout).toContain("EntityDescriptor");
          }).pipe(Effect.provide(testLayer), Effect.orDie),
        ),
    );

    testBehaviour("exits non-zero with --domains and --add-domains", ({ run }) =>
      Effect.runPromise(
        Effect.gen(function* () {
          const result = yield* Effect.promise(() =>
            run([
              "sso",
              "update",
              PROVIDER_ID,
              "--domains",
              "a.com",
              "--add-domains",
              "b.com",
              "--project-ref",
              PROJECT_REF,
            ]),
          );
          expect(result.exitCode).not.toBe(0);
          expect(result.stderr).toContain("domains");
        }).pipe(Effect.provide(testLayer), Effect.orDie),
      ),
    );

    testBehaviour("exits non-zero on 401", ({ run, apiUrl }) =>
      Effect.runPromise(
        Effect.gen(function* () {
          yield* Effect.promise(() =>
            httpRequest(`${apiUrl}/_ctrl/error-all`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: { status: 401, body: { message: "Invalid token" } },
            }),
          );
          const result = yield* Effect.promise(() =>
            run([
              "sso",
              "update",
              PROVIDER_ID,
              "--add-domains",
              "example.com",
              "--project-ref",
              PROJECT_REF,
            ]),
          );
          expect(result.exitCode).not.toBe(0);
          expect(result.stderr).toContain("Invalid token");
        }).pipe(Effect.provide(testLayer), Effect.orDie),
      ),
    );

    testBehaviour("exits non-zero on 403", ({ run, apiUrl }) =>
      Effect.runPromise(
        Effect.gen(function* () {
          yield* Effect.promise(() =>
            httpRequest(`${apiUrl}/_ctrl/error-all`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: { status: 403, body: { message: "Forbidden" } },
            }),
          );
          const result = yield* Effect.promise(() =>
            run([
              "sso",
              "update",
              PROVIDER_ID,
              "--add-domains",
              "example.com",
              "--project-ref",
              PROJECT_REF,
            ]),
          );
          expect(result.exitCode).not.toBe(0);
          expect(result.stderr).toContain("Forbidden");
        }).pipe(Effect.provide(testLayer), Effect.orDie),
      ),
    );

    testBehaviour("exits non-zero on 404 provider not found", ({ run, apiUrl }) =>
      Effect.runPromise(
        Effect.gen(function* () {
          yield* Effect.promise(() =>
            httpRequest(`${apiUrl}/_ctrl/error-all`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: { status: 404, body: { message: "SSO Identity Provider not found" } },
            }),
          );
          const result = yield* Effect.promise(() =>
            run([
              "sso",
              "update",
              PROVIDER_ID,
              "--add-domains",
              "example.com",
              "--project-ref",
              PROJECT_REF,
            ]),
          );
          expect(result.exitCode).not.toBe(0);
          expect(result.stderr).toContain("could not be found");
        }).pipe(Effect.provide(testLayer), Effect.orDie),
      ),
    );

    testBehaviour("exits non-zero on 429", ({ run, apiUrl }) =>
      Effect.runPromise(
        Effect.gen(function* () {
          yield* Effect.promise(() =>
            httpRequest(`${apiUrl}/_ctrl/error-all`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: { status: 429, body: { message: "Too Many Requests" } },
            }),
          );
          const result = yield* Effect.promise(() =>
            run([
              "sso",
              "update",
              PROVIDER_ID,
              "--add-domains",
              "example.com",
              "--project-ref",
              PROJECT_REF,
            ]),
          );
          expect(result.exitCode).not.toBe(0);
          expect(result.stderr).toContain("Too Many Requests");
        }).pipe(Effect.provide(testLayer), Effect.orDie),
      ),
    );

    testBehaviour("exits non-zero on 500", ({ run, apiUrl }) =>
      Effect.runPromise(
        Effect.gen(function* () {
          yield* Effect.promise(() =>
            httpRequest(`${apiUrl}/_ctrl/error-all`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: { status: 500, body: { message: "Internal Server Error" } },
            }),
          );
          const result = yield* Effect.promise(() =>
            run([
              "sso",
              "update",
              PROVIDER_ID,
              "--add-domains",
              "example.com",
              "--project-ref",
              PROJECT_REF,
            ]),
          );
          expect(result.exitCode).not.toBe(0);
          expect(result.stderr).toContain("Internal Server Error");
        }).pipe(Effect.provide(testLayer), Effect.orDie),
      ),
    );
  });

  describe("sso:remove", () => {
    testBehaviour.skipIf(isRecording)("removes a provider", ({ run }) =>
      Effect.runPromise(
        Effect.gen(function* () {
          const result = yield* Effect.promise(() =>
            run(["sso", "remove", PROVIDER_ID, "--project-ref", PROJECT_REF]),
          );
          expect(result.exitCode).toBe(0);
          expect(result.stdout).toContain("example.com");
        }).pipe(Effect.provide(testLayer), Effect.orDie),
      ),
    );

    testBehaviour("exits non-zero on 401", ({ run, apiUrl }) =>
      Effect.runPromise(
        Effect.gen(function* () {
          yield* Effect.promise(() =>
            httpRequest(`${apiUrl}/_ctrl/error-all`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: { status: 401, body: { message: "Invalid token" } },
            }),
          );
          const result = yield* Effect.promise(() =>
            run(["sso", "remove", PROVIDER_ID, "--project-ref", PROJECT_REF]),
          );
          expect(result.exitCode).not.toBe(0);
          expect(result.stderr).toContain("Invalid token");
        }).pipe(Effect.provide(testLayer), Effect.orDie),
      ),
    );

    testBehaviour("exits non-zero on 403", ({ run, apiUrl }) =>
      Effect.runPromise(
        Effect.gen(function* () {
          yield* Effect.promise(() =>
            httpRequest(`${apiUrl}/_ctrl/error-all`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: { status: 403, body: { message: "Forbidden" } },
            }),
          );
          const result = yield* Effect.promise(() =>
            run(["sso", "remove", PROVIDER_ID, "--project-ref", PROJECT_REF]),
          );
          expect(result.exitCode).not.toBe(0);
          expect(result.stderr).toContain("Forbidden");
        }).pipe(Effect.provide(testLayer), Effect.orDie),
      ),
    );

    testBehaviour("exits non-zero on 404 provider not found", ({ run, apiUrl }) =>
      Effect.runPromise(
        Effect.gen(function* () {
          yield* Effect.promise(() =>
            httpRequest(`${apiUrl}/_ctrl/error-all`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: { status: 404, body: { message: "SSO Identity Provider not found" } },
            }),
          );
          const result = yield* Effect.promise(() =>
            run(["sso", "remove", PROVIDER_ID, "--project-ref", PROJECT_REF]),
          );
          expect(result.exitCode).not.toBe(0);
          expect(result.stderr).toContain("could not be found");
        }).pipe(Effect.provide(testLayer), Effect.orDie),
      ),
    );

    testBehaviour("exits non-zero on 429", ({ run, apiUrl }) =>
      Effect.runPromise(
        Effect.gen(function* () {
          yield* Effect.promise(() =>
            httpRequest(`${apiUrl}/_ctrl/error-all`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: { status: 429, body: { message: "Too Many Requests" } },
            }),
          );
          const result = yield* Effect.promise(() =>
            run(["sso", "remove", PROVIDER_ID, "--project-ref", PROJECT_REF]),
          );
          expect(result.exitCode).not.toBe(0);
          expect(result.stderr).toContain("Too Many Requests");
        }).pipe(Effect.provide(testLayer), Effect.orDie),
      ),
    );

    testBehaviour("exits non-zero on 500", ({ run, apiUrl }) =>
      Effect.runPromise(
        Effect.gen(function* () {
          yield* Effect.promise(() =>
            httpRequest(`${apiUrl}/_ctrl/error-all`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: { status: 500, body: { message: "Internal Server Error" } },
            }),
          );
          const result = yield* Effect.promise(() =>
            run(["sso", "remove", PROVIDER_ID, "--project-ref", PROJECT_REF]),
          );
          expect(result.exitCode).not.toBe(0);
          expect(result.stderr).toContain("Internal Server Error");
        }).pipe(Effect.provide(testLayer), Effect.orDie),
      ),
    );
  });
});
