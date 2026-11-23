import { describe, expect, it } from "@effect/vitest";
import { Deferred, Effect, Option } from "effect";
import { useTempWorkdir, VALID_REF } from "../../../tests/helpers/command-mocks.ts";
import {
  lintRow,
  setupAdvisors,
  type AdvisorTestOptions,
} from "../../../tests/helpers/advisors.ts";
import { OutputFlag } from "../../command-internal/global-flags.ts";
import { Tty } from "../../shared/runtime/tty.service.ts";
import { issues } from "./issues.handler.ts";
import type { IssuesFlags } from "./issues.command.ts";

const tempRoot = useTempWorkdir("supabase-issues-int-");
const setup = (opts?: AdvisorTestOptions) => setupAdvisors(tempRoot.current, opts);
const REMOTE_LINKED: IssuesFlags["remote"] = Option.some({ _tag: "Linked" });

const flags = (over: Partial<IssuesFlags> = {}): IssuesFlags => ({
  dbUrl: Option.none(),
  remote: Option.none(),
  linked: false,
  local: false,
  projectRef: Option.none(),
  type: Option.none(),
  severity: Option.none(),
  failOn: Option.none(),
  ...over,
});
describe("issues", () => {
  it.effect.each([
    { direct: false, format: "json" as const },
    { direct: true, format: "stream-json" as const },
  ])("groups local and direct database findings without text output (%j)", ({ direct, format }) => {
    const { layer, out, connection } = setup({
      format,
      rows: [
        lintRow(),
        lintRow({
          level: "INFO",
          cache_key: "second",
          metadata: {
            name: "search",
            type: "function",
            schema: "app",
            arguments: "text, integer",
          },
        }),
      ],
    });
    return Effect.gen(function* () {
      yield* issues(
        flags(
          direct
            ? { dbUrl: Option.some("postgresql://postgres:postgres@localhost:54322/postgres") }
            : {},
        ),
      );
      expect(out.messages).toContainEqual({
        type: "success",
        message: "issues",
        data: {
          issues: [
            expect.objectContaining({
              id: "rls_disabled_in_public",
              severity: "critical",
              affected: [
                expect.objectContaining({ id: "rls_disabled_in_public_public_users" }),
                expect.objectContaining({
                  id: "second",
                  severity: "info",
                  resource: { name: "search(text, integer)", type: "function", schema: "app" },
                }),
              ],
            }),
          ],
          checks: [
            { type: "security", status: "complete" },
            { type: "performance", status: "complete" },
            {
              type: "health",
              status: "unavailable",
              reason: "Health checks require a remote project.",
            },
          ],
        },
      });
      expect(connection.execs.at(-1)).toBe("rollback");
      expect(out.stdoutText).toBe("");
    }).pipe(Effect.provide(layer));
  });
  it.effect("rejects local health before opening a database connection", () => {
    const { layer, connection } = setup();
    return Effect.gen(function* () {
      const error = yield* Effect.flip(issues(flags({ type: Option.some("health") })));
      expect(error._tag).toBe("IssuesHealthUnsupportedError");
      expect(connection.execs).toEqual([]);
    }).pipe(Effect.provide(layer));
  });
  it.effect(
    "filters groups after maximum severity and applies fail-on only to displayed issues",
    () => {
      const { layer, out, processControl } = setup({
        format: "json",
        rows: [lintRow({ level: "WARN" })],
      });
      return Effect.gen(function* () {
        yield* issues(flags({ severity: Option.some("critical"), failOn: Option.some("info") }));
        expect(processControl.exitCode).toBeUndefined();
        expect(out.messages).toContainEqual(
          expect.objectContaining({ data: expect.objectContaining({ issues: [] }) }),
        );
      }).pipe(Effect.provide(layer));
    },
  );
  it.effect("runs remote health with all four checks and returns critical issues", () => {
    const { layer, out, api, processControl, cache } = setup({
      format: "json",
      healthLints: [lintRow({ name: "log_auth_error_rate_high", categories: ["HEALTH"] })],
    });
    return Effect.gen(function* () {
      yield* issues(
        flags({
          remote: REMOTE_LINKED,
          type: Option.some("health"),
          failOn: Option.some("warning"),
        }),
      );
      expect(out.messages).toContainEqual(
        expect.objectContaining({
          data: {
            issues: [
              expect.objectContaining({
                id: "log_auth_error_rate_high",
                category: "health",
                severity: "critical",
              }),
            ],
            checks: [{ type: "health", status: "complete" }],
          },
        }),
      );
      expect(processControl.exitCode).toBe(1);
      expect(api.requests.find((request) => request.url.includes("/advisors/run"))?.body).toEqual({
        data: {
          type: "project_advisors",
          attributes: {
            lints: [
              { name: "log_data_api_error_rate_high" },
              { name: "log_auth_error_rate_high" },
              { name: "log_storage_error_rate_high" },
              { name: "log_edge_function_error_rate_high" },
            ],
          },
        },
      });
      expect(cache.cachedRef).toBe(VALID_REF);
    }).pipe(Effect.provide(layer));
  });
  it.effect.each(["advisor_check_unavailable", "project_not_active"])(
    "never reports %s as clean remote health",
    (name) => {
      const { layer, out, processControl } = setup({
        format: "json",
        healthLints: [lintRow({ name, categories: ["HEALTH"] })],
      });
      return Effect.gen(function* () {
        yield* issues(flags({ remote: REMOTE_LINKED, type: Option.some("health") }));
        expect(out.messages).toContainEqual(
          expect.objectContaining({
            data: expect.objectContaining({
              checks: [
                {
                  type: "health",
                  status: "unavailable",
                  reason: `${name}: Table public.users has RLS disabled`,
                },
              ],
            }),
          }),
        );
        expect(processControl.exitCode).toBe(1);
      }).pipe(Effect.provide(layer));
    },
  );
  it.effect.each(["security", "performance", "health"] as const)(
    "preserves successful categories when %s returns HTTP 503",
    (failed) => {
      const { layer, out, cache, processControl, telemetry } = setup({
        format: "json",
        securityStatus: failed === "security" ? 503 : 200,
        performanceStatus: failed === "performance" ? 503 : 200,
        healthStatus: failed === "health" ? 503 : 200,
        securityLints: [lintRow()],
        performanceLints: [lintRow({ name: "unused_index" })],
        healthLints: [lintRow({ name: "log_auth_error_rate_high" })],
      });
      return Effect.gen(function* () {
        yield* issues(flags({ remote: REMOTE_LINKED }));
        expect(out.messages).toContainEqual(
          expect.objectContaining({
            type: "success",
            data: {
              issues: expect.arrayContaining(
                ["security", "performance", "health"]
                  .filter((category) => category !== failed)
                  .map((category) => expect.objectContaining({ category })),
              ),
              checks: ["security", "performance", "health"].map((category) =>
                category === failed
                  ? {
                      type: category,
                      status: "unavailable",
                      reason: expect.stringContaining("503"),
                    }
                  : { type: category, status: "complete" },
              ),
            },
          }),
        );
        const result = out.messages.find((message) => message.type === "success")?.data;
        expect(result).toHaveProperty("issues.length", 2);
        expect(processControl.exitCode).toBe(1);
        expect(cache.cachedRef).toBe(VALID_REF);
        expect(telemetry.flushed).toBe(true);
      }).pipe(Effect.provide(layer));
    },
  );
  it.effect("keeps category order when concurrent requests finish in reverse order", () =>
    Effect.gen(function* () {
      const securityReady = yield* Deferred.make<void>();
      const performanceReady = yield* Deferred.make<void>();
      const releaseSecurity = yield* Deferred.make<void>();
      const releasePerformance = yield* Deferred.make<void>();
      const completed: string[] = [];
      const { layer, out } = setup({
        format: "json",
        beforeResponse: (url) =>
          Effect.gen(function* () {
            if (url.includes("/advisors/security")) {
              yield* Deferred.succeed(securityReady, undefined);
              yield* Deferred.await(releaseSecurity);
              completed.push("security");
            } else if (url.includes("/advisors/performance")) {
              yield* Deferred.succeed(performanceReady, undefined);
              yield* Deferred.await(releasePerformance);
              completed.push("performance");
              yield* Deferred.succeed(releaseSecurity, undefined);
            } else if (url.includes("/advisors/run")) {
              yield* Deferred.await(securityReady);
              yield* Deferred.await(performanceReady);
              completed.push("health");
              yield* Deferred.succeed(releasePerformance, undefined);
            }
          }),
      });
      yield* issues(flags({ remote: REMOTE_LINKED })).pipe(Effect.provide(layer));
      expect(completed).toEqual(["health", "performance", "security"]);
      expect(out.messages).toContainEqual(
        expect.objectContaining({
          data: {
            issues: [],
            checks: [
              { type: "security", status: "complete" },
              { type: "performance", status: "complete" },
              { type: "health", status: "complete" },
            ],
          },
        }),
      );
    }),
  );
  it.effect.each([
    { category: "security", status: 401, tag: "DbAdvisorsSecurityStatusError" },
    { category: "security", status: 403, tag: "DbAdvisorsSecurityStatusError" },
    { category: "performance", status: 401, tag: "DbAdvisorsPerformanceStatusError" },
    { category: "performance", status: 403, tag: "DbAdvisorsPerformanceStatusError" },
    { category: "health", status: 401, tag: "IssuesHealthAuthorizationError" },
    { category: "health", status: 403, tag: "IssuesHealthAuthorizationError" },
  ] as const)(
    "propagates $category HTTP $status without incomplete success",
    ({ category, status, tag }) => {
      const { layer, out, cache, telemetry } = setup({
        format: "json",
        securityStatus: category === "security" ? status : 200,
        performanceStatus: category === "performance" ? status : 200,
        healthStatus: category === "health" ? status : 200,
      });
      return Effect.gen(function* () {
        const error = yield* Effect.flip(
          issues(flags({ remote: REMOTE_LINKED, type: Option.some(category) })),
        );
        expect(error).toMatchObject({ _tag: tag, status });
        expect(out.messages.some((message) => message.type === "success")).toBe(false);
        expect(cache.cachedRef).toBe(VALID_REF);
        expect(telemetry.flushed).toBe(true);
      }).pipe(Effect.provide(layer));
    },
  );
});

describe("issues boundary failures", () => {
  it.effect("attributes security endpoint findings and unavailable diagnostics to security", () => {
    const { layer, out, processControl } = setup({
      format: "json",
      securityLints: [
        lintRow({ categories: [] }),
        lintRow({ name: "advisor_check_unavailable", categories: ["HEALTH"] }),
      ],
    });
    return Effect.gen(function* () {
      yield* issues(flags({ remote: REMOTE_LINKED, type: Option.some("security") }));
      expect(out.messages).toContainEqual(
        expect.objectContaining({
          data: {
            issues: [expect.objectContaining({ category: "security" })],
            checks: [
              {
                type: "security",
                status: "unavailable",
                reason: "advisor_check_unavailable: Table public.users has RLS disabled",
              },
            ],
          },
        }),
      );
      expect(processControl.exitCode).toBe(1);
    }).pipe(Effect.provide(layer));
  });
  it.effect.each([false, true])(
    "rejects future severity values without reporting a clean success (remote %s)",
    (remote) => {
      const { layer, out } = setup({
        format: "json",
        rows: [lintRow({ level: "FUTURE" })],
        securityLints: [lintRow({ level: "FUTURE" })],
      });
      return Effect.gen(function* () {
        const error = yield* Effect.flip(
          issues(
            flags({
              remote: remote ? REMOTE_LINKED : Option.none(),
              type: Option.some("security"),
            }),
          ),
        );
        expect(error._tag).toBe("SchemaError");
        expect(out.messages.some((message) => message.type === "success")).toBe(false);
      }).pipe(Effect.provide(layer));
    },
  );
  it.effect("rejects legacy output formats before any database connection", () => {
    const { layer, connection } = setup();
    return Effect.gen(function* () {
      const error = yield* Effect.flip(
        issues(flags()).pipe(Effect.provideService(OutputFlag, Option.some("yaml"))),
      );
      expect(error).toMatchObject({
        _tag: "IssuesOutputFlagUnsupportedError",
        message:
          "the -o/--output flag is not supported by issues; use --output-format json|stream-json instead.",
      });
      expect(connection.execs).toEqual([]);
    }).pipe(Effect.provide(layer));
  });
});

describe("issues readable text", () => {
  it.effect(
    "renders grouped findings as a table with coverage and a complete-evidence hint",
    () => {
      const { layer, out, processControl } = setup({
        rows: [
          lintRow(),
          lintRow({
            cache_key: "second",
            metadata: { schema: "public", name: "teams", type: "table" },
          }),
        ],
      });
      return Effect.gen(function* () {
        yield* issues(flags({ failOn: Option.some("warning") }));
        expect(out.stdoutText).toContain("1 issue (info or higher).");
        expect(out.stdoutText).toMatch(/│ Severity\s+│ Category\s+│ Issue\s+│ Affected\s+│/u);
        expect(out.stdoutText).toMatch(
          /│ critical\s+│ security\s+│ RLS disabled in public\s+│ 2\s+│/u,
        );
        expect(out.stdoutText).toContain("security: complete");
        expect(out.stdoutText).toContain(
          "health: unavailable — Health checks require a remote project.",
        );
        expect(out.stdoutText).toContain("Some checks are unavailable; results are incomplete.");
        expect(out.stdoutText.replaceAll(/\s+/gu, " ")).toContain(
          "Use --output-format json for affected resources, evidence, and remediation links.",
        );
        expect(processControl.exitCode).toBe(1);
        expect(out.messages.some((message) => message.type === "success")).toBe(false);
      }).pipe(Effect.provide(layer));
    },
  );
  it.effect.each([false, true])(
    "describes empty filtered findings without hiding incomplete coverage (unavailable %s)",
    (unavailable) => {
      const { layer, out, processControl } = setup({
        securityLints: [lintRow({ level: "WARN" })],
        healthLints: unavailable
          ? [
              lintRow({
                name: "advisor_check_unavailable",
                detail: "Health logs are temporarily unavailable",
              }),
            ]
          : [],
      });
      return Effect.gen(function* () {
        yield* issues(
          flags({
            remote: REMOTE_LINKED,
            severity: Option.some("critical"),
            failOn: Option.some("info"),
          }),
        );
        expect(out.stdoutText).toContain("No issues match --severity critical.");
        expect(out.stdoutText).toContain("security: complete");
        expect(out.stdoutText).toContain(
          unavailable
            ? "health: unavailable — advisor_check_unavailable: Health logs are temporarily"
            : "health: complete",
        );
        if (unavailable)
          expect(out.stdoutText).toContain("Some checks are unavailable; results are incomplete.");
        expect(processControl.exitCode).toBe(unavailable ? 1 : undefined);
      }).pipe(Effect.provide(layer));
    },
  );
  it.effect.each([80, 120])("uses the terminal's %s-column width for long titles", (columns) => {
    const { layer, out } = setup({
      rows: [lintRow({ title: "Long database check title ".repeat(8) })],
    });
    return Effect.gen(function* () {
      yield* issues(flags({ type: Option.some("security") })).pipe(
        Effect.provideService(Tty, {
          stdinIsTty: false,
          stdoutIsTty: true,
          stdoutIsPipe: false,
          stdoutColumns: columns,
        }),
      );
      const separator = out.stdoutText.split("\n").find((line) => line.startsWith("┌"));
      expect(separator?.length).toBe(columns);
    }).pipe(Effect.provide(layer));
  });
});
