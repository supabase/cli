import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect } from "vitest";
import { isRecording, PROJECT_REF, PROVIDER_ID } from "./env.ts";
import { testBehaviour, testParity } from "./test-context.ts";

const MINIMAL_SAML_XML = `<?xml version="1.0" encoding="UTF-8"?>
<md:EntityDescriptor xmlns:md="urn:oasis:names:tc:SAML:2.0:metadata" entityID="https://example.com/saml">
  <md:IDPSSODescriptor WantAuthnRequestsSigned="false" protocolSupportEnumeration="urn:oasis:names:tc:SAML:2.0:protocol">
    <md:SingleSignOnService Binding="urn:oasis:names:tc:SAML:2.0:bindings:HTTP-POST" Location="https://example.com/saml/sso"/>
  </md:IDPSSODescriptor>
</md:EntityDescriptor>`;

describe("sso", () => {
  describe("sso:list", () => {
    testBehaviour("renders fixture data in output", async ({ run, projectRef }) => {
      const result = await run(["sso", "list", "--project-ref", projectRef]);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("IDENTITY PROVIDER ID");
    });

    testBehaviour("returns json output with --output json", async ({ run, projectRef }) => {
      const result = await run(["sso", "list", "--output", "json", "--project-ref", projectRef]);
      expect(result.exitCode).toBe(0);
      expect(JSON.parse(result.stdout)).toMatchObject({ providers: [] });
    });

    testBehaviour("includes debug output with --debug", async ({ run, projectRef }) => {
      const result = await run(["sso", "list", "--debug", "--project-ref", projectRef]);
      expect(result.exitCode).toBe(0);
      expect(result.stderr).toMatch(/HTTP.*GET:/);
    });

    testBehaviour("exits non-zero on 401", async ({ run, apiUrl }) => {
      await fetch(`${apiUrl}/_ctrl/error-all`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: 401, body: { message: "Invalid token" } }),
      });
      const result = await run(["sso", "list", "--project-ref", PROJECT_REF]);
      expect(result.exitCode).not.toBe(0);
      expect(result.stderr).toContain("Invalid token");
    });

    testBehaviour("exits non-zero on 403", async ({ run, apiUrl }) => {
      await fetch(`${apiUrl}/_ctrl/error-all`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: 403, body: { message: "Forbidden" } }),
      });
      const result = await run(["sso", "list", "--project-ref", PROJECT_REF]);
      expect(result.exitCode).not.toBe(0);
      expect(result.stderr).toContain("Forbidden");
    });

    testBehaviour("exits non-zero on 404 project not found", async ({ run, apiUrl }) => {
      await fetch(`${apiUrl}/_ctrl/error-all`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: 404, body: { message: "Project not found" } }),
      });
      const result = await run(["sso", "list", "--project-ref", PROJECT_REF]);
      expect(result.exitCode).not.toBe(0);
      expect(result.stderr).toContain("SAML 2.0 support is not enabled");
    });

    testBehaviour("exits non-zero on 429", async ({ run, apiUrl }) => {
      await fetch(`${apiUrl}/_ctrl/error-all`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: 429, body: { message: "Too Many Requests" } }),
      });
      const result = await run(["sso", "list", "--project-ref", PROJECT_REF]);
      expect(result.exitCode).not.toBe(0);
      expect(result.stderr).toContain("Too Many Requests");
    });

    testBehaviour("exits non-zero on 500", async ({ run, apiUrl }) => {
      await fetch(`${apiUrl}/_ctrl/error-all`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: 500, body: { message: "Internal Server Error" } }),
      });
      const result = await run(["sso", "list", "--project-ref", PROJECT_REF]);
      expect(result.exitCode).not.toBe(0);
      expect(result.stderr).toContain("Internal Server Error");
    });

    testParity(["sso", "list", "--project-ref", PROJECT_REF]);
    testParity(["sso", "list", "--project-ref", PROJECT_REF], { failureType: "NON_AUTH" });
  });

  describe("sso:info", () => {
    testBehaviour("renders fixture data in output", async ({ run, projectRef }) => {
      const result = await run(["sso", "info", "--project-ref", projectRef]);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("supabase.co/auth/v1/sso/saml/acs");
    });

    testBehaviour("returns json output with --output json", async ({ run, projectRef }) => {
      const result = await run(["sso", "info", "--output", "json", "--project-ref", projectRef]);
      expect(result.exitCode).toBe(0);
      expect(JSON.parse(result.stdout)).toMatchObject({
        acs_url: expect.stringContaining("supabase.co/auth/v1/sso/saml/acs"),
      });
    });

    // sso info makes no API calls — no error injection tests needed
    testParity(["sso", "info", "--project-ref", PROJECT_REF]);
  });

  describe("sso:show", () => {
    testBehaviour.skipIf(isRecording)(
      "renders fixture data in output",
      async ({ run, projectRef }) => {
        const result = await run(["sso", "show", PROVIDER_ID, "--project-ref", projectRef]);
        expect(result.exitCode).toBe(0);
        expect(result.stdout).toContain("example.com");
      },
    );

    testBehaviour.skipIf(isRecording)(
      "returns json output with --output json",
      async ({ run, projectRef }) => {
        const result = await run([
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
      },
    );

    testBehaviour.skipIf(isRecording)(
      "shows raw SAML metadata XML with --metadata",
      async ({ run, projectRef }) => {
        const result = await run([
          "sso",
          "show",
          PROVIDER_ID,
          "--metadata",
          "--project-ref",
          projectRef,
        ]);
        expect(result.exitCode).toBe(0);
        expect(result.stdout).toContain("EntityDescriptor");
      },
    );

    testBehaviour("exits non-zero on 401", async ({ run, apiUrl }) => {
      await fetch(`${apiUrl}/_ctrl/error-all`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: 401, body: { message: "Invalid token" } }),
      });
      const result = await run(["sso", "show", PROVIDER_ID, "--project-ref", PROJECT_REF]);
      expect(result.exitCode).not.toBe(0);
      expect(result.stderr).toContain("Invalid token");
    });

    testBehaviour("exits non-zero on 403", async ({ run, apiUrl }) => {
      await fetch(`${apiUrl}/_ctrl/error-all`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: 403, body: { message: "Forbidden" } }),
      });
      const result = await run(["sso", "show", PROVIDER_ID, "--project-ref", PROJECT_REF]);
      expect(result.exitCode).not.toBe(0);
      expect(result.stderr).toContain("Forbidden");
    });

    testBehaviour("exits non-zero on 404 provider not found", async ({ run, apiUrl }) => {
      await fetch(`${apiUrl}/_ctrl/error-all`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: 404, body: { message: "SSO Identity Provider not found" } }),
      });
      const result = await run(["sso", "show", PROVIDER_ID, "--project-ref", PROJECT_REF]);
      expect(result.exitCode).not.toBe(0);
      expect(result.stderr).toContain("could not be found");
    });

    testBehaviour("exits non-zero on 429", async ({ run, apiUrl }) => {
      await fetch(`${apiUrl}/_ctrl/error-all`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: 429, body: { message: "Too Many Requests" } }),
      });
      const result = await run(["sso", "show", PROVIDER_ID, "--project-ref", PROJECT_REF]);
      expect(result.exitCode).not.toBe(0);
      expect(result.stderr).toContain("Too Many Requests");
    });

    testBehaviour("exits non-zero on 500", async ({ run, apiUrl }) => {
      await fetch(`${apiUrl}/_ctrl/error-all`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: 500, body: { message: "Internal Server Error" } }),
      });
      const result = await run(["sso", "show", PROVIDER_ID, "--project-ref", PROJECT_REF]);
      expect(result.exitCode).not.toBe(0);
      expect(result.stderr).toContain("Internal Server Error");
    });

    testParity(["sso", "show", PROVIDER_ID, "--project-ref", PROJECT_REF]);
    testParity(["sso", "show", PROVIDER_ID, "--project-ref", PROJECT_REF], {
      failureType: "NON_AUTH",
    });
  });

  describe("sso:add", () => {
    testBehaviour(
      "adds SAML provider via metadata file",
      async ({ run, projectRef, workspace }) => {
        const metadataPath = join(workspace.path, "saml.xml");
        writeFileSync(metadataPath, MINIMAL_SAML_XML);
        const result = await run([
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
      },
    );

    testBehaviour("exits non-zero without --type", async ({ run }) => {
      const result = await run([
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
    });

    testBehaviour(
      "exits non-zero with both --metadata-url and --metadata-file",
      async ({ run, workspace }) => {
        const metadataPath = join(workspace.path, "saml.xml");
        writeFileSync(metadataPath, MINIMAL_SAML_XML);
        const result = await run([
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
      },
    );

    testBehaviour("exits non-zero with unreachable --metadata-url", async ({ run }) => {
      const result = await run([
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
    });

    testBehaviour("exits non-zero on 401", async ({ run, apiUrl, workspace }) => {
      const metadataPath = join(workspace.path, "saml.xml");
      writeFileSync(metadataPath, MINIMAL_SAML_XML);
      await fetch(`${apiUrl}/_ctrl/error-all`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: 401, body: { message: "Invalid token" } }),
      });
      const result = await run([
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
    });

    testBehaviour("exits non-zero on 403", async ({ run, apiUrl, workspace }) => {
      const metadataPath = join(workspace.path, "saml.xml");
      writeFileSync(metadataPath, MINIMAL_SAML_XML);
      await fetch(`${apiUrl}/_ctrl/error-all`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: 403, body: { message: "Forbidden" } }),
      });
      const result = await run([
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
    });

    testBehaviour("exits non-zero on 422 invalid metadata", async ({ run, apiUrl, workspace }) => {
      const metadataPath = join(workspace.path, "saml.xml");
      writeFileSync(metadataPath, MINIMAL_SAML_XML);
      await fetch(`${apiUrl}/_ctrl/error-all`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          status: 422,
          body: { message: "Invalid SAML metadata" },
        }),
      });
      const result = await run([
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
    });

    testBehaviour("exits non-zero on 429", async ({ run, apiUrl, workspace }) => {
      const metadataPath = join(workspace.path, "saml.xml");
      writeFileSync(metadataPath, MINIMAL_SAML_XML);
      await fetch(`${apiUrl}/_ctrl/error-all`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: 429, body: { message: "Too Many Requests" } }),
      });
      const result = await run([
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
    });

    testBehaviour("exits non-zero on 500", async ({ run, apiUrl, workspace }) => {
      const metadataPath = join(workspace.path, "saml.xml");
      writeFileSync(metadataPath, MINIMAL_SAML_XML);
      await fetch(`${apiUrl}/_ctrl/error-all`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: 500, body: { message: "Internal Server Error" } }),
      });
      const result = await run([
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
    });

    // No success parity: metadata-file is required for reliable recording, but
    // testParity has no workspace to write the file. NON_AUTH covers argument
    // forwarding parity between Go and ts-legacy.
    testParity(
      [
        "sso",
        "add",
        "--type",
        "saml",
        "--metadata-url",
        "https://example.com/saml/metadata",
        "--skip-url-validation",
        "--domains",
        "example.com",
        "--project-ref",
        PROJECT_REF,
      ],
      { failureType: "NON_AUTH" },
    );
  });

  describe("sso:update", () => {
    testBehaviour.skipIf(isRecording)(
      "appends domain with --add-domains",
      async ({ run, projectRef }) => {
        const result = await run([
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
      },
    );

    testBehaviour.skipIf(isRecording)(
      "replaces domains with --domains",
      async ({ run, projectRef }) => {
        const result = await run([
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
      },
    );

    testBehaviour.skipIf(isRecording)(
      "removes domain with --remove-domains",
      async ({ run, projectRef }) => {
        const result = await run([
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
      },
    );

    testBehaviour.skipIf(isRecording)(
      "updates metadata via metadata file",
      async ({ run, projectRef, workspace }) => {
        const metadataPath = join(workspace.path, "saml.xml");
        writeFileSync(metadataPath, MINIMAL_SAML_XML);
        const result = await run([
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
      },
    );

    testBehaviour("exits non-zero with --domains and --add-domains", async ({ run }) => {
      const result = await run([
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
    });

    testBehaviour("exits non-zero on 401", async ({ run, apiUrl }) => {
      await fetch(`${apiUrl}/_ctrl/error-all`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: 401, body: { message: "Invalid token" } }),
      });
      const result = await run([
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
    });

    testBehaviour("exits non-zero on 403", async ({ run, apiUrl }) => {
      await fetch(`${apiUrl}/_ctrl/error-all`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: 403, body: { message: "Forbidden" } }),
      });
      const result = await run([
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
    });

    testBehaviour("exits non-zero on 404 provider not found", async ({ run, apiUrl }) => {
      await fetch(`${apiUrl}/_ctrl/error-all`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: 404, body: { message: "SSO Identity Provider not found" } }),
      });
      const result = await run([
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
    });

    testBehaviour("exits non-zero on 429", async ({ run, apiUrl }) => {
      await fetch(`${apiUrl}/_ctrl/error-all`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: 429, body: { message: "Too Many Requests" } }),
      });
      const result = await run([
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
    });

    testBehaviour("exits non-zero on 500", async ({ run, apiUrl }) => {
      await fetch(`${apiUrl}/_ctrl/error-all`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: 500, body: { message: "Internal Server Error" } }),
      });
      const result = await run([
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
    });

    testParity([
      "sso",
      "update",
      PROVIDER_ID,
      "--add-domains",
      "example.com",
      "--project-ref",
      PROJECT_REF,
    ]);
    testParity(
      ["sso", "update", PROVIDER_ID, "--add-domains", "example.com", "--project-ref", PROJECT_REF],
      { failureType: "NON_AUTH" },
    );
  });

  describe("sso:remove", () => {
    testBehaviour.skipIf(isRecording)("removes a provider", async ({ run }) => {
      const result = await run(["sso", "remove", PROVIDER_ID, "--project-ref", PROJECT_REF]);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("example.com");
    });

    testBehaviour("exits non-zero on 401", async ({ run, apiUrl }) => {
      await fetch(`${apiUrl}/_ctrl/error-all`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: 401, body: { message: "Invalid token" } }),
      });
      const result = await run(["sso", "remove", PROVIDER_ID, "--project-ref", PROJECT_REF]);
      expect(result.exitCode).not.toBe(0);
      expect(result.stderr).toContain("Invalid token");
    });

    testBehaviour("exits non-zero on 403", async ({ run, apiUrl }) => {
      await fetch(`${apiUrl}/_ctrl/error-all`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: 403, body: { message: "Forbidden" } }),
      });
      const result = await run(["sso", "remove", PROVIDER_ID, "--project-ref", PROJECT_REF]);
      expect(result.exitCode).not.toBe(0);
      expect(result.stderr).toContain("Forbidden");
    });

    testBehaviour("exits non-zero on 404 provider not found", async ({ run, apiUrl }) => {
      await fetch(`${apiUrl}/_ctrl/error-all`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: 404, body: { message: "SSO Identity Provider not found" } }),
      });
      const result = await run(["sso", "remove", PROVIDER_ID, "--project-ref", PROJECT_REF]);
      expect(result.exitCode).not.toBe(0);
      expect(result.stderr).toContain("could not be found");
    });

    testBehaviour("exits non-zero on 429", async ({ run, apiUrl }) => {
      await fetch(`${apiUrl}/_ctrl/error-all`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: 429, body: { message: "Too Many Requests" } }),
      });
      const result = await run(["sso", "remove", PROVIDER_ID, "--project-ref", PROJECT_REF]);
      expect(result.exitCode).not.toBe(0);
      expect(result.stderr).toContain("Too Many Requests");
    });

    testBehaviour("exits non-zero on 500", async ({ run, apiUrl }) => {
      await fetch(`${apiUrl}/_ctrl/error-all`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: 500, body: { message: "Internal Server Error" } }),
      });
      const result = await run(["sso", "remove", PROVIDER_ID, "--project-ref", PROJECT_REF]);
      expect(result.exitCode).not.toBe(0);
      expect(result.stderr).toContain("Internal Server Error");
    });

    // No success parity: the happy-path fixture is hand-crafted (destructive operation)
    // and has no corresponding recorded/ fixture for testParity to use.
    testParity(["sso", "remove", PROVIDER_ID, "--project-ref", PROJECT_REF], {
      failureType: "NON_AUTH",
    });
  });
});
