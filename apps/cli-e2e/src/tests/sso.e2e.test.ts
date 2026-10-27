import { Effect, FileSystem, Path, Schema } from "effect";
import { describe, expect } from "vitest";
import { isRecording, PROJECT_REF, PROVIDER_ID } from "./env.ts";
import { decodeJsonOutput, postControl, runE2e, testBehaviour } from "./test-context.ts";

const MINIMAL_SAML_XML = `<?xml version="1.0" encoding="UTF-8"?>
<md:EntityDescriptor xmlns:md="urn:oasis:names:tc:SAML:2.0:metadata" entityID="https://example.com/saml">
  <md:IDPSSODescriptor WantAuthnRequestsSigned="false" protocolSupportEnumeration="urn:oasis:names:tc:SAML:2.0:protocol">
    <md:SingleSignOnService Binding="urn:oasis:names:tc:SAML:2.0:bindings:HTTP-POST" Location="https://example.com/saml/sso"/>
  </md:IDPSSODescriptor>
</md:EntityDescriptor>`;

describe("sso", () => {
  describe("sso:list", () => {
    testBehaviour("renders fixture data in output", ({ run, projectRef, signal }) =>
      runE2e(
        Effect.gen(function* () {
          const result = yield* run(["sso", "list", "--project-ref", projectRef]);
          expect(result.exitCode).toBe(0);
          expect(result.stdout).toContain("IDENTITY PROVIDER ID");
        }),
        signal,
      ),
    );

    testBehaviour("returns json output with --output json", ({ run, projectRef, signal }) =>
      runE2e(
        Effect.gen(function* () {
          const result = yield* run([
            "sso",
            "list",
            "--output",
            "json",
            "--project-ref",
            projectRef,
          ]);
          expect(result.exitCode).toBe(0);
          expect(yield* decodeJsonOutput(Schema.Unknown)(result.stdout)).toMatchObject({
            providers: [],
          });
        }),
        signal,
      ),
    );

    testBehaviour("includes debug output with --debug", ({ run, projectRef, signal }) =>
      runE2e(
        Effect.gen(function* () {
          const result = yield* run(["sso", "list", "--debug", "--project-ref", projectRef]);
          expect(result.exitCode).toBe(0);
          expect(result.stderr).toMatch(/HTTP.*GET:/);
        }),
        signal,
      ),
    );

    testBehaviour("exits non-zero on 401", ({ run, apiUrl, signal }) =>
      runE2e(
        Effect.gen(function* () {
          yield* postControl(`${apiUrl}/_ctrl/error-all`, {
            status: 401,
            body: { message: "Invalid token" },
          });
          const result = yield* run(["sso", "list", "--project-ref", PROJECT_REF]);
          expect(result.exitCode).not.toBe(0);
          expect(result.stderr).toContain("Invalid token");
        }),
        signal,
      ),
    );

    testBehaviour("exits non-zero on 403", ({ run, apiUrl, signal }) =>
      runE2e(
        Effect.gen(function* () {
          yield* postControl(`${apiUrl}/_ctrl/error-all`, {
            status: 403,
            body: { message: "Forbidden" },
          });
          const result = yield* run(["sso", "list", "--project-ref", PROJECT_REF]);
          expect(result.exitCode).not.toBe(0);
          expect(result.stderr).toContain("Forbidden");
        }),
        signal,
      ),
    );

    testBehaviour("exits non-zero on 404 project not found", ({ run, apiUrl, signal }) =>
      runE2e(
        Effect.gen(function* () {
          yield* postControl(`${apiUrl}/_ctrl/error-all`, {
            status: 404,
            body: { message: "Project not found" },
          });
          const result = yield* run(["sso", "list", "--project-ref", PROJECT_REF]);
          expect(result.exitCode).not.toBe(0);
          expect(result.stderr).toContain("SAML 2.0 support is not enabled");
        }),
        signal,
      ),
    );

    testBehaviour("exits non-zero on 429", ({ run, apiUrl, signal }) =>
      runE2e(
        Effect.gen(function* () {
          yield* postControl(`${apiUrl}/_ctrl/error-all`, {
            status: 429,
            body: { message: "Too Many Requests" },
          });
          const result = yield* run(["sso", "list", "--project-ref", PROJECT_REF]);
          expect(result.exitCode).not.toBe(0);
          expect(result.stderr).toContain("Too Many Requests");
        }),
        signal,
      ),
    );

    testBehaviour("exits non-zero on 500", ({ run, apiUrl, signal }) =>
      runE2e(
        Effect.gen(function* () {
          yield* postControl(`${apiUrl}/_ctrl/error-all`, {
            status: 500,
            body: { message: "Internal Server Error" },
          });
          const result = yield* run(["sso", "list", "--project-ref", PROJECT_REF]);
          expect(result.exitCode).not.toBe(0);
          expect(result.stderr).toContain("Internal Server Error");
        }),
        signal,
      ),
    );
  });

  describe("sso:info", () => {
    testBehaviour("renders fixture data in output", ({ run, projectRef, signal }) =>
      runE2e(
        Effect.gen(function* () {
          const result = yield* run(["sso", "info", "--project-ref", projectRef]);
          expect(result.exitCode).toBe(0);
          expect(result.stdout).toContain("supabase.co/auth/v1/sso/saml/acs");
        }),
        signal,
      ),
    );

    testBehaviour("returns json output with --output json", ({ run, projectRef, signal }) =>
      runE2e(
        Effect.gen(function* () {
          const result = yield* run([
            "sso",
            "info",
            "--output",
            "json",
            "--project-ref",
            projectRef,
          ]);
          expect(result.exitCode).toBe(0);
          expect(yield* decodeJsonOutput(Schema.Unknown)(result.stdout)).toMatchObject({
            acs_url: expect.stringContaining("supabase.co/auth/v1/sso/saml/acs"),
          });
        }),
        signal,
      ),
    );

    // sso info makes no API calls — no error injection tests needed
  });

  describe("sso:show", () => {
    testBehaviour.skipIf(isRecording)(
      "renders fixture data in output",
      ({ run, projectRef, signal }) =>
        runE2e(
          Effect.gen(function* () {
            const result = yield* run(["sso", "show", PROVIDER_ID, "--project-ref", projectRef]);
            expect(result.exitCode).toBe(0);
            expect(result.stdout).toContain("example.com");
          }),
          signal,
        ),
    );

    testBehaviour.skipIf(isRecording)(
      "returns json output with --output json",
      ({ run, projectRef, signal }) =>
        runE2e(
          Effect.gen(function* () {
            const result = yield* run([
              "sso",
              "show",
              PROVIDER_ID,
              "--output",
              "json",
              "--project-ref",
              projectRef,
            ]);
            expect(result.exitCode).toBe(0);
            expect(result.stdout).toContain("example.com");
          }),
          signal,
        ),
    );

    testBehaviour.skipIf(isRecording)(
      "shows raw SAML metadata XML with --metadata",
      ({ run, projectRef, signal }) =>
        runE2e(
          Effect.gen(function* () {
            const result = yield* run([
              "sso",
              "show",
              PROVIDER_ID,
              "--metadata",
              "--project-ref",
              projectRef,
            ]);
            expect(result.exitCode).toBe(0);
            expect(result.stdout).toContain("EntityDescriptor");
          }),
          signal,
        ),
    );

    testBehaviour("exits non-zero on 401", ({ run, apiUrl, signal }) =>
      runE2e(
        Effect.gen(function* () {
          yield* postControl(`${apiUrl}/_ctrl/error-all`, {
            status: 401,
            body: { message: "Invalid token" },
          });
          const result = yield* run(["sso", "show", PROVIDER_ID, "--project-ref", PROJECT_REF]);
          expect(result.exitCode).not.toBe(0);
          expect(result.stderr).toContain("Invalid token");
        }),
        signal,
      ),
    );

    testBehaviour("exits non-zero on 403", ({ run, apiUrl, signal }) =>
      runE2e(
        Effect.gen(function* () {
          yield* postControl(`${apiUrl}/_ctrl/error-all`, {
            status: 403,
            body: { message: "Forbidden" },
          });
          const result = yield* run(["sso", "show", PROVIDER_ID, "--project-ref", PROJECT_REF]);
          expect(result.exitCode).not.toBe(0);
          expect(result.stderr).toContain("Forbidden");
        }),
        signal,
      ),
    );

    testBehaviour("exits non-zero on 404 provider not found", ({ run, apiUrl, signal }) =>
      runE2e(
        Effect.gen(function* () {
          yield* postControl(`${apiUrl}/_ctrl/error-all`, {
            status: 404,
            body: { message: "SSO Identity Provider not found" },
          });
          const result = yield* run(["sso", "show", PROVIDER_ID, "--project-ref", PROJECT_REF]);
          expect(result.exitCode).not.toBe(0);
          expect(result.stderr).toContain("could not be found");
        }),
        signal,
      ),
    );

    testBehaviour("exits non-zero on 429", ({ run, apiUrl, signal }) =>
      runE2e(
        Effect.gen(function* () {
          yield* postControl(`${apiUrl}/_ctrl/error-all`, {
            status: 429,
            body: { message: "Too Many Requests" },
          });
          const result = yield* run(["sso", "show", PROVIDER_ID, "--project-ref", PROJECT_REF]);
          expect(result.exitCode).not.toBe(0);
          expect(result.stderr).toContain("Too Many Requests");
        }),
        signal,
      ),
    );

    testBehaviour("exits non-zero on 500", ({ run, apiUrl, signal }) =>
      runE2e(
        Effect.gen(function* () {
          yield* postControl(`${apiUrl}/_ctrl/error-all`, {
            status: 500,
            body: { message: "Internal Server Error" },
          });
          const result = yield* run(["sso", "show", PROVIDER_ID, "--project-ref", PROJECT_REF]);
          expect(result.exitCode).not.toBe(0);
          expect(result.stderr).toContain("Internal Server Error");
        }),
        signal,
      ),
    );
  });

  describe("sso:add", () => {
    testBehaviour(
      "adds SAML provider via metadata file",
      ({ run, projectRef, workspace, signal }) =>
        runE2e(
          Effect.gen(function* () {
            const fs = yield* FileSystem.FileSystem;
            const path = yield* Path.Path;
            const metadataPath = path.join(workspace.path, "saml.xml");
            yield* fs.writeFileString(metadataPath, MINIMAL_SAML_XML);
            const result = yield* run([
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
            ]);
            expect(result.exitCode).toBe(0);
            expect(result.stdout).toContain("example.com");
          }),
          signal,
        ),
    );

    testBehaviour("exits non-zero without --type", ({ run, signal }) =>
      runE2e(
        Effect.gen(function* () {
          const result = yield* run([
            "sso",
            "add",
            "--metadata-url",
            "https://example.com/saml/metadata",
            "--skip-url-validation",
            "--project-ref",
            PROJECT_REF,
          ]);
          expect(result.exitCode).not.toBe(0);
          expect(result.stderr).toContain('"type"');
        }),
        signal,
      ),
    );

    testBehaviour(
      "exits non-zero with both --metadata-url and --metadata-file",
      ({ run, workspace, signal }) =>
        runE2e(
          Effect.gen(function* () {
            const fs = yield* FileSystem.FileSystem;
            const path = yield* Path.Path;
            const metadataPath = path.join(workspace.path, "saml.xml");
            yield* fs.writeFileString(metadataPath, MINIMAL_SAML_XML);
            const result = yield* run([
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
            ]);
            expect(result.exitCode).not.toBe(0);
            expect(result.stderr).toContain("metadata");
          }),
          signal,
        ),
    );

    testBehaviour("exits non-zero with unreachable --metadata-url", ({ run, signal }) =>
      runE2e(
        Effect.gen(function* () {
          const result = yield* run([
            "sso",
            "add",
            "--type",
            "saml",
            "--metadata-url",
            "http://localhost:19999/saml.xml",
            "--project-ref",
            PROJECT_REF,
          ]);
          expect(result.exitCode).not.toBe(0);
          expect(result.stderr).toContain("HTTPS");
        }),
        signal,
      ),
    );

    testBehaviour("exits non-zero on 401", ({ run, apiUrl, workspace, signal }) =>
      runE2e(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const metadataPath = path.join(workspace.path, "saml.xml");
          yield* fs.writeFileString(metadataPath, MINIMAL_SAML_XML);
          yield* postControl(`${apiUrl}/_ctrl/error-all`, {
            status: 401,
            body: { message: "Invalid token" },
          });
          const result = yield* run([
            "sso",
            "add",
            "--type",
            "saml",
            "--metadata-file",
            metadataPath,
            "--project-ref",
            PROJECT_REF,
          ]);
          expect(result.exitCode).not.toBe(0);
          expect(result.stderr).toContain("Invalid token");
        }),
        signal,
      ),
    );

    testBehaviour("exits non-zero on 403", ({ run, apiUrl, workspace, signal }) =>
      runE2e(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const metadataPath = path.join(workspace.path, "saml.xml");
          yield* fs.writeFileString(metadataPath, MINIMAL_SAML_XML);
          yield* postControl(`${apiUrl}/_ctrl/error-all`, {
            status: 403,
            body: { message: "Forbidden" },
          });
          const result = yield* run([
            "sso",
            "add",
            "--type",
            "saml",
            "--metadata-file",
            metadataPath,
            "--project-ref",
            PROJECT_REF,
          ]);
          expect(result.exitCode).not.toBe(0);
          expect(result.stderr).toContain("Forbidden");
        }),
        signal,
      ),
    );

    testBehaviour("exits non-zero on 422 invalid metadata", ({ run, apiUrl, workspace, signal }) =>
      runE2e(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const metadataPath = path.join(workspace.path, "saml.xml");
          yield* fs.writeFileString(metadataPath, MINIMAL_SAML_XML);
          yield* postControl(`${apiUrl}/_ctrl/error-all`, {
            status: 422,
            body: { message: "Invalid SAML metadata" },
          });
          const result = yield* run([
            "sso",
            "add",
            "--type",
            "saml",
            "--metadata-file",
            metadataPath,
            "--project-ref",
            PROJECT_REF,
          ]);
          expect(result.exitCode).not.toBe(0);
          expect(result.stderr).toContain("Invalid SAML metadata");
        }),
        signal,
      ),
    );

    testBehaviour("exits non-zero on 429", ({ run, apiUrl, workspace, signal }) =>
      runE2e(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const metadataPath = path.join(workspace.path, "saml.xml");
          yield* fs.writeFileString(metadataPath, MINIMAL_SAML_XML);
          yield* postControl(`${apiUrl}/_ctrl/error-all`, {
            status: 429,
            body: { message: "Too Many Requests" },
          });
          const result = yield* run([
            "sso",
            "add",
            "--type",
            "saml",
            "--metadata-file",
            metadataPath,
            "--project-ref",
            PROJECT_REF,
          ]);
          expect(result.exitCode).not.toBe(0);
          expect(result.stderr).toContain("Too Many Requests");
        }),
        signal,
      ),
    );

    testBehaviour("exits non-zero on 500", ({ run, apiUrl, workspace, signal }) =>
      runE2e(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const metadataPath = path.join(workspace.path, "saml.xml");
          yield* fs.writeFileString(metadataPath, MINIMAL_SAML_XML);
          yield* postControl(`${apiUrl}/_ctrl/error-all`, {
            status: 500,
            body: { message: "Internal Server Error" },
          });
          const result = yield* run([
            "sso",
            "add",
            "--type",
            "saml",
            "--metadata-file",
            metadataPath,
            "--project-ref",
            PROJECT_REF,
          ]);
          expect(result.exitCode).not.toBe(0);
          expect(result.stderr).toContain("Internal Server Error");
        }),
        signal,
      ),
    );
  });

  describe("sso:update", () => {
    testBehaviour.skipIf(isRecording)(
      "appends domain with --add-domains",
      ({ run, projectRef, signal }) =>
        runE2e(
          Effect.gen(function* () {
            const result = yield* run([
              "sso",
              "update",
              PROVIDER_ID,
              "--add-domains",
              "example.com",
              "--project-ref",
              projectRef,
            ]);
            expect(result.exitCode).toBe(0);
            expect(result.stdout).toContain("example.com");
          }),
          signal,
        ),
    );

    testBehaviour.skipIf(isRecording)(
      "replaces domains with --domains",
      ({ run, projectRef, signal }) =>
        runE2e(
          Effect.gen(function* () {
            const result = yield* run([
              "sso",
              "update",
              PROVIDER_ID,
              "--domains",
              "new.com",
              "--project-ref",
              projectRef,
            ]);
            expect(result.exitCode).toBe(0);
            expect(result.stdout).toContain("new.com");
          }),
          signal,
        ),
    );

    testBehaviour.skipIf(isRecording)(
      "removes domain with --remove-domains",
      ({ run, projectRef, signal }) =>
        runE2e(
          Effect.gen(function* () {
            const result = yield* run([
              "sso",
              "update",
              PROVIDER_ID,
              "--remove-domains",
              "example.com",
              "--project-ref",
              projectRef,
            ]);
            expect(result.exitCode).toBe(0);
            expect(result.stdout).toContain("IDENTITY PROVIDER ID");
          }),
          signal,
        ),
    );

    testBehaviour.skipIf(isRecording)(
      "updates metadata via metadata file",
      ({ run, projectRef, workspace, signal }) =>
        runE2e(
          Effect.gen(function* () {
            const fs = yield* FileSystem.FileSystem;
            const path = yield* Path.Path;
            const metadataPath = path.join(workspace.path, "saml.xml");
            yield* fs.writeFileString(metadataPath, MINIMAL_SAML_XML);
            const result = yield* run([
              "sso",
              "update",
              PROVIDER_ID,
              "--metadata-file",
              metadataPath,
              "--project-ref",
              projectRef,
            ]);
            expect(result.exitCode).toBe(0);
            expect(result.stdout).toContain("EntityDescriptor");
          }),
          signal,
        ),
    );

    testBehaviour("exits non-zero with --domains and --add-domains", ({ run, signal }) =>
      runE2e(
        Effect.gen(function* () {
          const result = yield* run([
            "sso",
            "update",
            PROVIDER_ID,
            "--domains",
            "a.com",
            "--add-domains",
            "b.com",
            "--project-ref",
            PROJECT_REF,
          ]);
          expect(result.exitCode).not.toBe(0);
          expect(result.stderr).toContain("domains");
        }),
        signal,
      ),
    );

    testBehaviour("exits non-zero on 401", ({ run, apiUrl, signal }) =>
      runE2e(
        Effect.gen(function* () {
          yield* postControl(`${apiUrl}/_ctrl/error-all`, {
            status: 401,
            body: { message: "Invalid token" },
          });
          const result = yield* run([
            "sso",
            "update",
            PROVIDER_ID,
            "--add-domains",
            "example.com",
            "--project-ref",
            PROJECT_REF,
          ]);
          expect(result.exitCode).not.toBe(0);
          expect(result.stderr).toContain("Invalid token");
        }),
        signal,
      ),
    );

    testBehaviour("exits non-zero on 403", ({ run, apiUrl, signal }) =>
      runE2e(
        Effect.gen(function* () {
          yield* postControl(`${apiUrl}/_ctrl/error-all`, {
            status: 403,
            body: { message: "Forbidden" },
          });
          const result = yield* run([
            "sso",
            "update",
            PROVIDER_ID,
            "--add-domains",
            "example.com",
            "--project-ref",
            PROJECT_REF,
          ]);
          expect(result.exitCode).not.toBe(0);
          expect(result.stderr).toContain("Forbidden");
        }),
        signal,
      ),
    );

    testBehaviour("exits non-zero on 404 provider not found", ({ run, apiUrl, signal }) =>
      runE2e(
        Effect.gen(function* () {
          yield* postControl(`${apiUrl}/_ctrl/error-all`, {
            status: 404,
            body: { message: "SSO Identity Provider not found" },
          });
          const result = yield* run([
            "sso",
            "update",
            PROVIDER_ID,
            "--add-domains",
            "example.com",
            "--project-ref",
            PROJECT_REF,
          ]);
          expect(result.exitCode).not.toBe(0);
          expect(result.stderr).toContain("could not be found");
        }),
        signal,
      ),
    );

    testBehaviour("exits non-zero on 429", ({ run, apiUrl, signal }) =>
      runE2e(
        Effect.gen(function* () {
          yield* postControl(`${apiUrl}/_ctrl/error-all`, {
            status: 429,
            body: { message: "Too Many Requests" },
          });
          const result = yield* run([
            "sso",
            "update",
            PROVIDER_ID,
            "--add-domains",
            "example.com",
            "--project-ref",
            PROJECT_REF,
          ]);
          expect(result.exitCode).not.toBe(0);
          expect(result.stderr).toContain("Too Many Requests");
        }),
        signal,
      ),
    );

    testBehaviour("exits non-zero on 500", ({ run, apiUrl, signal }) =>
      runE2e(
        Effect.gen(function* () {
          yield* postControl(`${apiUrl}/_ctrl/error-all`, {
            status: 500,
            body: { message: "Internal Server Error" },
          });
          const result = yield* run([
            "sso",
            "update",
            PROVIDER_ID,
            "--add-domains",
            "example.com",
            "--project-ref",
            PROJECT_REF,
          ]);
          expect(result.exitCode).not.toBe(0);
          expect(result.stderr).toContain("Internal Server Error");
        }),
        signal,
      ),
    );
  });

  describe("sso:remove", () => {
    testBehaviour.skipIf(isRecording)("removes a provider", ({ run, signal }) =>
      runE2e(
        Effect.gen(function* () {
          const result = yield* run(["sso", "remove", PROVIDER_ID, "--project-ref", PROJECT_REF]);
          expect(result.exitCode).toBe(0);
          expect(result.stdout).toContain("example.com");
        }),
        signal,
      ),
    );

    testBehaviour("exits non-zero on 401", ({ run, apiUrl, signal }) =>
      runE2e(
        Effect.gen(function* () {
          yield* postControl(`${apiUrl}/_ctrl/error-all`, {
            status: 401,
            body: { message: "Invalid token" },
          });
          const result = yield* run(["sso", "remove", PROVIDER_ID, "--project-ref", PROJECT_REF]);
          expect(result.exitCode).not.toBe(0);
          expect(result.stderr).toContain("Invalid token");
        }),
        signal,
      ),
    );

    testBehaviour("exits non-zero on 403", ({ run, apiUrl, signal }) =>
      runE2e(
        Effect.gen(function* () {
          yield* postControl(`${apiUrl}/_ctrl/error-all`, {
            status: 403,
            body: { message: "Forbidden" },
          });
          const result = yield* run(["sso", "remove", PROVIDER_ID, "--project-ref", PROJECT_REF]);
          expect(result.exitCode).not.toBe(0);
          expect(result.stderr).toContain("Forbidden");
        }),
        signal,
      ),
    );

    testBehaviour("exits non-zero on 404 provider not found", ({ run, apiUrl, signal }) =>
      runE2e(
        Effect.gen(function* () {
          yield* postControl(`${apiUrl}/_ctrl/error-all`, {
            status: 404,
            body: { message: "SSO Identity Provider not found" },
          });
          const result = yield* run(["sso", "remove", PROVIDER_ID, "--project-ref", PROJECT_REF]);
          expect(result.exitCode).not.toBe(0);
          expect(result.stderr).toContain("could not be found");
        }),
        signal,
      ),
    );

    testBehaviour("exits non-zero on 429", ({ run, apiUrl, signal }) =>
      runE2e(
        Effect.gen(function* () {
          yield* postControl(`${apiUrl}/_ctrl/error-all`, {
            status: 429,
            body: { message: "Too Many Requests" },
          });
          const result = yield* run(["sso", "remove", PROVIDER_ID, "--project-ref", PROJECT_REF]);
          expect(result.exitCode).not.toBe(0);
          expect(result.stderr).toContain("Too Many Requests");
        }),
        signal,
      ),
    );

    testBehaviour("exits non-zero on 500", ({ run, apiUrl, signal }) =>
      runE2e(
        Effect.gen(function* () {
          yield* postControl(`${apiUrl}/_ctrl/error-all`, {
            status: 500,
            body: { message: "Internal Server Error" },
          });
          const result = yield* run(["sso", "remove", PROVIDER_ID, "--project-ref", PROJECT_REF]);
          expect(result.exitCode).not.toBe(0);
          expect(result.stderr).toContain("Internal Server Error");
        }),
        signal,
      ),
    );
  });
});
