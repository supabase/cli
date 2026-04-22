import { describe, expect } from "vitest";
import { isRecording, PROJECT_REF } from "./env.ts";
import { testBehaviour, testParity } from "./test-context.ts";

function decodeJwtPart(part: string): Record<string, unknown> {
  const padded = part + "=".repeat((4 - (part.length % 4)) % 4);
  return JSON.parse(Buffer.from(padded, "base64").toString("utf8")) as Record<string, unknown>;
}

describe("gen", () => {
  describe("gen:types", () => {
    testBehaviour.skipIf(isRecording)(
      "generates typescript types from project",
      async ({ run, projectRef }) => {
        const result = await run(["gen", "types", "--project-id", projectRef]);
        expect(result.exitCode).toBe(0);
        expect(result.stdout).toContain("export type Json");
        expect(result.stdout).toContain("export type Database");
      },
    );

    testBehaviour.skipIf(isRecording)(
      "includes debug output with --debug",
      async ({ run, projectRef }) => {
        const result = await run(["gen", "types", "--debug", "--project-id", projectRef]);
        expect(result.exitCode).toBe(0);
        expect(result.stderr).toMatch(/HTTP.*GET:/);
      },
    );

    testBehaviour("exits non-zero on 401", async ({ run, apiUrl }) => {
      await fetch(`${apiUrl}/_ctrl/error-all`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: 401, body: { message: "Invalid token" } }),
      });
      const result = await run(["gen", "types", "--project-id", PROJECT_REF]);
      expect(result.exitCode).not.toBe(0);
      expect(result.stderr).toContain("Invalid token");
    });

    testBehaviour("exits non-zero on 403", async ({ run, apiUrl }) => {
      await fetch(`${apiUrl}/_ctrl/error-all`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: 403, body: { message: "Forbidden" } }),
      });
      const result = await run(["gen", "types", "--project-id", PROJECT_REF]);
      expect(result.exitCode).not.toBe(0);
      expect(result.stderr).toContain("Forbidden");
    });

    testBehaviour("exits non-zero on 404 project not found", async ({ run, apiUrl }) => {
      await fetch(`${apiUrl}/_ctrl/error-all`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: 404, body: { message: "Project not found" } }),
      });
      const result = await run(["gen", "types", "--project-id", PROJECT_REF]);
      expect(result.exitCode).not.toBe(0);
      expect(result.stderr).toContain("Project not found");
    });

    testBehaviour("exits non-zero with --lang go when using --project-id", async ({ run }) => {
      const result = await run(["gen", "types", "--project-id", PROJECT_REF, "--lang", "go"]);
      expect(result.exitCode).not.toBe(0);
      expect(result.stderr).toContain("db-url");
    });

    testBehaviour("exits non-zero with no data source specified", async ({ run }) => {
      const result = await run(["gen", "types"]);
      expect(result.exitCode).not.toBe(0);
    });

    testParity(["gen", "types", "--project-id", PROJECT_REF]);
    testParity(["gen", "types", "--project-id", PROJECT_REF], { failureType: "NON_AUTH" });
  });

  describe("gen:signing-key", () => {
    testBehaviour("generates ES256 signing key by default", async ({ run }) => {
      const result = await run(["gen", "signing-key"]);
      expect(result.exitCode).toBe(0);
      const key = JSON.parse(result.stdout) as Record<string, unknown>;
      expect(key["kty"]).toBe("EC");
      expect(key["alg"]).toBe("ES256");
      expect(key["crv"]).toBe("P-256");
      expect(key["use"]).toBe("sig");
      expect(typeof key["d"]).toBe("string");
      expect((key["d"] as string).length).toBeGreaterThan(0);
    });

    testBehaviour("generates RS256 signing key with --algorithm RS256", async ({ run }) => {
      const result = await run(["gen", "signing-key", "--algorithm", "RS256"]);
      expect(result.exitCode).toBe(0);
      const key = JSON.parse(result.stdout) as Record<string, unknown>;
      expect(key["kty"]).toBe("RSA");
      expect(key["alg"]).toBe("RS256");
      expect(key["use"]).toBe("sig");
      expect(typeof key["n"]).toBe("string");
      expect((key["n"] as string).length).toBeGreaterThan(0);
    });

    testParity(["gen", "signing-key"]);
    testParity(["gen", "signing-key", "--algorithm", "RS256"]);
  });

  describe("gen:bearer-jwt", () => {
    testBehaviour("exits non-zero without --role", async ({ run }) => {
      const result = await run(["gen", "bearer-jwt"]);
      expect(result.exitCode).not.toBe(0);
      expect(result.stderr).toContain('"role"');
    });

    testBehaviour("generates bearer jwt for anon role", async ({ run }) => {
      const result = await run(["gen", "bearer-jwt", "--role", "anon"]);
      expect(result.exitCode).toBe(0);
      const parts = result.stdout.trim().split(".");
      expect(parts).toHaveLength(3);
      const header = decodeJwtPart(parts[0]!);
      expect(header["alg"]).toBe("ES256");
      expect(typeof header["kid"]).toBe("string");
      const payload = decodeJwtPart(parts[1]!);
      expect(payload["role"]).toBe("anon");
      expect(typeof payload["exp"]).toBe("number");
      expect(typeof payload["iat"]).toBe("number");
    });

    testBehaviour("generates bearer jwt with custom validity", async ({ run }) => {
      const result = await run(["gen", "bearer-jwt", "--role", "anon", "--valid-for", "1h"]);
      expect(result.exitCode).toBe(0);
      const parts = result.stdout.trim().split(".");
      expect(parts).toHaveLength(3);
      const payload = decodeJwtPart(parts[1]!);
      expect(payload["role"]).toBe("anon");
      expect((payload["exp"] as number) - (payload["iat"] as number)).toBe(3600);
    });

    testBehaviour(
      "generates bearer jwt for authenticated role with custom sub",
      async ({ run }) => {
        const result = await run([
          "gen",
          "bearer-jwt",
          "--role",
          "authenticated",
          "--sub",
          "user-123",
        ]);
        expect(result.exitCode).toBe(0);
        const parts = result.stdout.trim().split(".");
        expect(parts).toHaveLength(3);
        const payload = decodeJwtPart(parts[1]!);
        expect(payload["role"]).toBe("authenticated");
        expect(payload["sub"]).toBe("user-123");
      },
    );

    testParity(["gen", "bearer-jwt"]);
    testParity(["gen", "bearer-jwt", "--role", "anon"]);
  });
});
