import { Effect } from "effect";
import { describe, expect } from "vitest";
import { PROJECT_REF } from "./env.ts";
import { postControl, runE2e, testBehaviour } from "./test-context.ts";

describe("network-bans", () => {
  describe("network-bans:get", () => {
    testBehaviour("renders fixture data in output", ({ run, projectRef, signal }) =>
      runE2e(
        Effect.gen(function* () {
          const result = yield* run([
            "network-bans",
            "get",
            "--experimental",
            `--remote=${projectRef}`,
          ]);
          expect(result.exitCode).toBe(0);
        }),
        signal,
      ),
    );

    testBehaviour("returns json output with --output json", ({ run, projectRef, signal }) =>
      runE2e(
        Effect.gen(function* () {
          const result = yield* run([
            "network-bans",
            "get",
            "--experimental",
            "--output",
            "json",
            `--remote=${projectRef}`,
          ]);
          expect(result.exitCode).toBe(0);
        }),
        signal,
      ),
    );

    testBehaviour("includes debug output with --debug", ({ run, projectRef, signal }) =>
      runE2e(
        Effect.gen(function* () {
          const result = yield* run([
            "network-bans",
            "get",
            "--experimental",
            "--debug",
            `--remote=${projectRef}`,
          ]);
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
          const result = yield* run([
            "network-bans",
            "get",
            "--experimental",
            `--remote=${PROJECT_REF}`,
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
            "network-bans",
            "get",
            "--experimental",
            `--remote=${PROJECT_REF}`,
          ]);
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
          const result = yield* run([
            "network-bans",
            "get",
            "--experimental",
            `--remote=${PROJECT_REF}`,
          ]);
          expect(result.exitCode).not.toBe(0);
          expect(result.stderr).toContain("Project not found");
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
            "network-bans",
            "get",
            "--experimental",
            `--remote=${PROJECT_REF}`,
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
            "network-bans",
            "get",
            "--experimental",
            `--remote=${PROJECT_REF}`,
          ]);
          expect(result.exitCode).not.toBe(0);
          expect(result.stderr).toContain("Internal Server Error");
        }),
        signal,
      ),
    );
  });

  describe("network-bans:remove", () => {
    testBehaviour("removes IP from ban list", ({ run, projectRef, signal }) =>
      runE2e(
        Effect.gen(function* () {
          const result = yield* run([
            "network-bans",
            "remove",
            "--experimental",
            "--db-unban-ip",
            "1.2.3.4",
            "--yes",
            `--remote=${projectRef}`,
          ]);
          expect(result.exitCode).toBe(0);
        }),
        signal,
      ),
    );

    testBehaviour("removes multiple IPs from ban list", ({ run, projectRef, signal }) =>
      runE2e(
        Effect.gen(function* () {
          const result = yield* run([
            "network-bans",
            "remove",
            "--experimental",
            "--db-unban-ip",
            "1.2.3.4",
            "--db-unban-ip",
            "5.6.7.8",
            "--yes",
            `--remote=${projectRef}`,
          ]);
          expect(result.exitCode).toBe(0);
        }),
        signal,
      ),
    );

    testBehaviour("exits non-zero with invalid IP address", ({ run, signal }) =>
      runE2e(
        Effect.gen(function* () {
          const result = yield* run([
            "network-bans",
            "remove",
            "--experimental",
            "--db-unban-ip",
            "invalid-ip",
            "--yes",
            `--remote=${PROJECT_REF}`,
          ]);
          expect(result.exitCode).not.toBe(0);
          expect(result.stderr).toContain("invalid IP address");
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
            "network-bans",
            "remove",
            "--experimental",
            "--db-unban-ip",
            "1.2.3.4",
            "--yes",
            `--remote=${PROJECT_REF}`,
          ]);
          expect(result.exitCode).not.toBe(0);
          expect(result.stderr).toContain("Invalid token");
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
          const result = yield* run([
            "network-bans",
            "remove",
            "--experimental",
            "--db-unban-ip",
            "1.2.3.4",
            "--yes",
            `--remote=${PROJECT_REF}`,
          ]);
          expect(result.exitCode).not.toBe(0);
          expect(result.stderr).toContain("Project not found");
        }),
        signal,
      ),
    );
  });
});

describe("network-restrictions", () => {
  describe("network-restrictions:get", () => {
    testBehaviour("renders fixture data in output", ({ run, projectRef, signal }) =>
      runE2e(
        Effect.gen(function* () {
          const result = yield* run([
            "network-restrictions",
            "get",
            "--experimental",
            `--remote=${projectRef}`,
          ]);
          expect(result.exitCode).toBe(0);
        }),
        signal,
      ),
    );

    testBehaviour("returns json output with --output json", ({ run, projectRef, signal }) =>
      runE2e(
        Effect.gen(function* () {
          const result = yield* run([
            "network-restrictions",
            "get",
            "--experimental",
            "--output",
            "json",
            `--remote=${projectRef}`,
          ]);
          expect(result.exitCode).toBe(0);
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
            "network-restrictions",
            "get",
            "--experimental",
            `--remote=${PROJECT_REF}`,
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
            "network-restrictions",
            "get",
            "--experimental",
            `--remote=${PROJECT_REF}`,
          ]);
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
          const result = yield* run([
            "network-restrictions",
            "get",
            "--experimental",
            `--remote=${PROJECT_REF}`,
          ]);
          expect(result.exitCode).not.toBe(0);
          expect(result.stderr).toContain("Project not found");
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
            "network-restrictions",
            "get",
            "--experimental",
            `--remote=${PROJECT_REF}`,
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
            "network-restrictions",
            "get",
            "--experimental",
            `--remote=${PROJECT_REF}`,
          ]);
          expect(result.exitCode).not.toBe(0);
          expect(result.stderr).toContain("Internal Server Error");
        }),
        signal,
      ),
    );
  });

  describe("network-restrictions:update", () => {
    testBehaviour("sets CIDR allowlist", ({ run, projectRef, signal }) =>
      runE2e(
        Effect.gen(function* () {
          const result = yield* run([
            "network-restrictions",
            "update",
            "--experimental",
            "--db-allow-cidr",
            "0.0.0.0/0",
            "--yes",
            `--remote=${projectRef}`,
          ]);
          expect(result.exitCode).toBe(0);
        }),
        signal,
      ),
    );

    testBehaviour("appends to existing restrictions", ({ run, projectRef, signal }) =>
      runE2e(
        Effect.gen(function* () {
          const result = yield* run([
            "network-restrictions",
            "update",
            "--experimental",
            "--append",
            "--db-allow-cidr",
            "8.8.8.0/24",
            "--yes",
            `--remote=${projectRef}`,
          ]);
          expect(result.exitCode).toBe(0);
        }),
        signal,
      ),
    );

    testBehaviour("bypasses CIDR validation checks", ({ run, projectRef, signal }) =>
      runE2e(
        Effect.gen(function* () {
          const result = yield* run([
            "network-restrictions",
            "update",
            "--experimental",
            "--bypass-cidr-checks",
            "--db-allow-cidr",
            "0.0.0.0/0",
            "--yes",
            `--remote=${projectRef}`,
          ]);
          expect(result.exitCode).toBe(0);
        }),
        signal,
      ),
    );

    testBehaviour("exits non-zero with invalid CIDR format", ({ run, signal }) =>
      runE2e(
        Effect.gen(function* () {
          const result = yield* run([
            "network-restrictions",
            "update",
            "--experimental",
            "--db-allow-cidr",
            "not-a-cidr",
            "--yes",
            `--remote=${PROJECT_REF}`,
          ]);
          expect(result.exitCode).not.toBe(0);
          expect(result.stderr).toContain("failed to parse IP");
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
            "network-restrictions",
            "update",
            "--experimental",
            "--db-allow-cidr",
            "0.0.0.0/0",
            "--yes",
            `--remote=${PROJECT_REF}`,
          ]);
          expect(result.exitCode).not.toBe(0);
          expect(result.stderr).toContain("Invalid token");
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
          const result = yield* run([
            "network-restrictions",
            "update",
            "--experimental",
            "--db-allow-cidr",
            "0.0.0.0/0",
            "--yes",
            `--remote=${PROJECT_REF}`,
          ]);
          expect(result.exitCode).not.toBe(0);
          expect(result.stderr).toContain("Project not found");
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
            "network-restrictions",
            "update",
            "--experimental",
            "--db-allow-cidr",
            "0.0.0.0/0",
            "--yes",
            `--remote=${PROJECT_REF}`,
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
            "network-restrictions",
            "update",
            "--experimental",
            "--db-allow-cidr",
            "0.0.0.0/0",
            "--yes",
            `--remote=${PROJECT_REF}`,
          ]);
          expect(result.exitCode).not.toBe(0);
          expect(result.stderr).toContain("Internal Server Error");
        }),
        signal,
      ),
    );
  });
});

describe("ssl-enforcement", () => {
  describe("ssl-enforcement:get", () => {
    testBehaviour("renders fixture data in output", ({ run, projectRef, signal }) =>
      runE2e(
        Effect.gen(function* () {
          const result = yield* run([
            "ssl-enforcement",
            "get",
            "--experimental",
            `--remote=${projectRef}`,
          ]);
          expect(result.exitCode).toBe(0);
        }),
        signal,
      ),
    );

    testBehaviour("returns json output with --output json", ({ run, projectRef, signal }) =>
      runE2e(
        Effect.gen(function* () {
          const result = yield* run([
            "ssl-enforcement",
            "get",
            "--experimental",
            "--output",
            "json",
            `--remote=${projectRef}`,
          ]);
          expect(result.exitCode).toBe(0);
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
            "ssl-enforcement",
            "get",
            "--experimental",
            `--remote=${PROJECT_REF}`,
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
            "ssl-enforcement",
            "get",
            "--experimental",
            `--remote=${PROJECT_REF}`,
          ]);
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
          const result = yield* run([
            "ssl-enforcement",
            "get",
            "--experimental",
            `--remote=${PROJECT_REF}`,
          ]);
          expect(result.exitCode).not.toBe(0);
          expect(result.stderr).toContain("Project not found");
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
            "ssl-enforcement",
            "get",
            "--experimental",
            `--remote=${PROJECT_REF}`,
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
            "ssl-enforcement",
            "get",
            "--experimental",
            `--remote=${PROJECT_REF}`,
          ]);
          expect(result.exitCode).not.toBe(0);
          expect(result.stderr).toContain("Internal Server Error");
        }),
        signal,
      ),
    );
  });

  describe("ssl-enforcement:update", () => {
    testBehaviour("enables SSL enforcement", ({ run, projectRef, signal }) =>
      runE2e(
        Effect.gen(function* () {
          const result = yield* run([
            "ssl-enforcement",
            "update",
            "--experimental",
            "--enable-db-ssl-enforcement",
            "--yes",
            `--remote=${projectRef}`,
          ]);
          expect(result.exitCode).toBe(0);
        }),
        signal,
      ),
    );

    testBehaviour("disables SSL enforcement", ({ run, projectRef, signal }) =>
      runE2e(
        Effect.gen(function* () {
          const result = yield* run([
            "ssl-enforcement",
            "update",
            "--experimental",
            "--disable-db-ssl-enforcement",
            "--yes",
            `--remote=${projectRef}`,
          ]);
          expect(result.exitCode).toBe(0);
        }),
        signal,
      ),
    );

    testBehaviour("exits non-zero with mutually exclusive flags", ({ run, signal }) =>
      runE2e(
        Effect.gen(function* () {
          const result = yield* run([
            "ssl-enforcement",
            "update",
            "--experimental",
            "--enable-db-ssl-enforcement",
            "--disable-db-ssl-enforcement",
            "--yes",
            `--remote=${PROJECT_REF}`,
          ]);
          expect(result.exitCode).not.toBe(0);
        }),
        signal,
      ),
    );

    testBehaviour("exits non-zero with no flags provided", ({ run, signal }) =>
      runE2e(
        Effect.gen(function* () {
          const result = yield* run([
            "ssl-enforcement",
            "update",
            "--experimental",
            "--yes",
            `--remote=${PROJECT_REF}`,
          ]);
          expect(result.exitCode).not.toBe(0);
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
            "ssl-enforcement",
            "update",
            "--experimental",
            "--enable-db-ssl-enforcement",
            "--yes",
            `--remote=${PROJECT_REF}`,
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
            "ssl-enforcement",
            "update",
            "--experimental",
            "--enable-db-ssl-enforcement",
            "--yes",
            `--remote=${PROJECT_REF}`,
          ]);
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
          const result = yield* run([
            "ssl-enforcement",
            "update",
            "--experimental",
            "--enable-db-ssl-enforcement",
            "--yes",
            `--remote=${PROJECT_REF}`,
          ]);
          expect(result.exitCode).not.toBe(0);
          expect(result.stderr).toContain("Project not found");
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
            "ssl-enforcement",
            "update",
            "--experimental",
            "--enable-db-ssl-enforcement",
            "--yes",
            `--remote=${PROJECT_REF}`,
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
            "ssl-enforcement",
            "update",
            "--experimental",
            "--enable-db-ssl-enforcement",
            "--yes",
            `--remote=${PROJECT_REF}`,
          ]);
          expect(result.exitCode).not.toBe(0);
          expect(result.stderr).toContain("Internal Server Error");
        }),
        signal,
      ),
    );
  });
});
