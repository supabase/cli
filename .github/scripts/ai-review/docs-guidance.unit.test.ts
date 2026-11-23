import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BunServices } from "@effect/platform-bun";
import { ConfigProvider, Deferred, Effect, Fiber } from "effect";
import { TestClock } from "effect/testing";
import {
  collectGuidance as collectGuidanceEffect,
  GUIDE_PATHS,
  writeGuidance,
} from "./docs-guidance.ts";
import { guidanceReviewStatus, isReferenceSource } from "./docs-guidance-status.ts";
import { buildReviewPayload } from "./post-review.ts";

const collectGuidance = (...args: Parameters<typeof collectGuidanceEffect>) =>
  Effect.runPromise(collectGuidanceEffect(...args));

const sha = "a".repeat(40);

describe("CLI reference guidance", () => {
  test.each([
    ["apps/cli/docs/supabase/db/dump.md", true],
    ["apps/cli/src/commands/login/login.command.ts", true],
    ["apps/cli/src/shared/cli/flag-groups.ts", true],
    ["apps/cli/src/commands/login/login.integration.test.ts", false],
    ["apps/cli/docs/README.md", false],
    ["docs/reference/cli.yaml", false],
    ["packages/api/src/index.ts", false],
    [".github/workflows/ai-review.yml", false],
  ])("selects %s: %s", (path, expected) => {
    expect(isReferenceSource(path)).toBe(expected);
  });

  test("unrelated changes skip all network requests", async () => {
    let calls = 0;
    const snapshot = await collectGuidance(["README.md"], async () => {
      calls++;
      throw new Error("Must not fetch");
    });
    expect(calls).toBe(0);
    expect(snapshot).toEqual({ status: "not-applicable", sha: null, files: [] });
  });

  test.each([undefined, "test-read-only-token"])(
    "pins guidance and limits token %s to the revision request",
    async (token) => {
      const requests: string[] = [];
      const snapshot = await Effect.runPromise(
        collectGuidanceEffect(
          ["apps/cli/src/commands/login/login.command.ts"],
          async (url, init) => {
            requests.push(url);
            expect(init.redirect).toBe("error");
            expect(init.signal).toBeInstanceOf(AbortSignal);
            expect(init.headers).toEqual({
              Accept: "application/vnd.github+json",
              ...(url.startsWith("https://api.github.com/") && token
                ? { Authorization: `Bearer ${token}` }
                : {}),
            });
            return new Response(
              url.endsWith("/master")
                ? JSON.stringify({ object: { type: "commit", sha } })
                : "# Rule\nUse plain words.\n",
            );
          },
        ).pipe(
          Effect.provide(
            ConfigProvider.layer(ConfigProvider.fromUnknown(token ? { GH_TOKEN: token } : {})),
          ),
        ),
      );
      expect(requests).toEqual([
        "https://api.github.com/repos/supabase/supabase/git/ref/heads/master",
        ...GUIDE_PATHS.map(
          (path) => `https://raw.githubusercontent.com/supabase/supabase/${sha}/${path}`,
        ),
      ]);
      expect(snapshot).toEqual({
        status: "available",
        sha,
        files: GUIDE_PATHS.map((path) => ({ path, content: "# Rule\nUse plain words.\n" })),
      });
      expect(guidanceReviewStatus(snapshot)).toContain(`supabase/supabase@${sha}`);
      expect(guidanceReviewStatus(snapshot)).toContain("not a style pass");
    },
  );

  test.each([
    "network",
    "http",
    "invalid-json",
    "invalid-sha",
    "oversized-ref",
    "oversized-guide",
    "empty-guide",
    "partial",
  ])("reports %s failure without leaking partial guidance", async (failure) => {
    let calls = 0;
    const snapshot = await collectGuidance(
      ["apps/cli/src/commands/login/login.command.ts"],
      async () => {
        calls++;
        if (failure === "network") throw new Error("secret-shaped upstream detail");
        if (failure === "http") return new Response("private error", { status: 503 });
        if (calls === 1) {
          if (failure === "invalid-json") return new Response("not JSON");
          if (failure === "invalid-sha")
            return new Response(
              JSON.stringify({ object: { type: "commit", sha: "../../untrusted" } }),
            );
          if (failure === "oversized-ref") return new Response("x".repeat(64 * 1024 + 1));
          return new Response(JSON.stringify({ object: { type: "commit", sha } }));
        }
        if (failure === "oversized-guide") return new Response("x".repeat(512 * 1024 + 1));
        if (failure === "empty-guide") return new Response("  ");
        if (failure === "partial" && calls === 3) return new Response("missing", { status: 404 });
        return new Response("# Rule\n");
      },
    );
    expect(snapshot.status).toBe("unavailable");
    expect(snapshot.files).toEqual([]);
    expect(JSON.stringify(snapshot)).not.toContain("private error");
    expect(guidanceReviewStatus(snapshot)).toContain(
      "Ordinary code review continued; no style pass is claimed",
    );
    if (["invalid-json", "invalid-sha", "oversized-ref"].includes(failure)) expect(calls).toBe(1);
    if (failure === "partial") expect(snapshot.sha).toBe(sha);
  });

  test("an interrupted response records unavailable and discards partial guidance", async () => {
    const snapshot = await collectGuidance(
      ["apps/cli/docs/supabase/login.md"],
      async () =>
        new Response(
          new ReadableStream({
            start(controller) {
              controller.error(new DOMException("Timed out", "TimeoutError"));
            },
          }),
        ),
    );
    expect(snapshot).toEqual({ status: "unavailable", sha: null, files: [] });
  });

  test("whole-body deadline aborts a stalled guide and retains only revision provenance", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const reading = yield* Deferred.make<void>();
        let signal: AbortSignal | null | undefined;
        const snapshotFiber = yield* collectGuidanceEffect(
          ["apps/cli/docs/supabase/login.md"],
          (url, init) => {
            if (url.endsWith("/master"))
              return Promise.resolve(
                new Response(JSON.stringify({ object: { type: "commit", sha } })),
              );
            signal = init.signal;
            return Promise.resolve(
              new Response(
                new ReadableStream({
                  pull() {
                    Effect.runSync(Deferred.succeed(reading, undefined));
                    return new Promise<void>(() => {});
                  },
                }),
              ),
            );
          },
        ).pipe(Effect.forkScoped);
        yield* Deferred.await(reading);
        yield* TestClock.adjust("15 seconds");
        const snapshot = yield* Fiber.join(snapshotFiber);
        expect(snapshot).toEqual({ status: "unavailable", sha, files: [] });
        expect(signal?.aborted).toBe(true);
      }).pipe(Effect.scoped, Effect.provide(TestClock.layer())),
    ));

  test.each(["available", "unavailable", "not-applicable"] as const)(
    "posted advisory review retains %s status even with an oversized model summary",
    (status) => {
      const payload = buildReviewPayload(
        {
          summary: "Model summary. ".repeat(6000),
          findings: [],
          stats: { claude_total: 0, codex_total: 0 },
        },
        new Map(),
        {
          trigger: "manual",
          runUrl: "https://github.com/supabase/cli/actions/runs/1",
          modelsFooter: "test",
          docsGuidance: { status, sha },
        },
      );
      expect(payload.event).toBe("COMMENT");
      expect(payload.body).toContain(
        status === "available"
          ? `snapshot supabase/supabase@${sha}`
          : `guidance: ${status === "not-applicable" ? "not applicable" : "unavailable"}`,
      );
      if (status === "unavailable") expect(payload.body).toContain("no style pass is claimed");
      expect(payload.body).toContain("truncated");
    },
  );

  test("artifact contains readable Markdown and one manifest with pinned provenance", async () => {
    const directory = mkdtempSync(join(tmpdir(), "docs-guidance-artifact-"));
    const procedure = join(directory, "trusted-procedure.md");
    writeFileSync(procedure, "# Trusted CLI procedure\n");
    const content = "# Actual rule\n\nUse plain words.\n".repeat(200);
    try {
      const snapshot = await collectGuidance(
        ["apps/cli/docs/supabase/login.md"],
        async (url) =>
          new Response(
            url.endsWith("/master") ? JSON.stringify({ object: { type: "commit", sha } }) : content,
          ),
      );
      await Effect.runPromise(
        writeGuidance(snapshot, directory, procedure).pipe(Effect.provide(BunServices.layer)),
      );
      const manifest = JSON.parse(readFileSync(join(directory, "docs-guidance.json"), "utf8"));
      expect(manifest).toEqual({
        status: "available",
        sha,
        files: GUIDE_PATHS.map((path) => ({
          path,
          localPath: `docs-guidance/${path.split("/").at(-1)}`,
        })),
      });
      for (const file of manifest.files) {
        expect(readFileSync(join(directory, file.localPath), "utf8")).toBe(content);
      }
      expect(readFileSync(join(directory, "cli-reference-procedure.md"), "utf8")).toBe(
        "# Trusted CLI procedure\n",
      );
      expect(readFileSync(join(directory, "docs-guidance.json"), "utf8")).not.toContain(
        "Actual rule",
      );
      await Effect.runPromise(
        writeGuidance({ status: "unavailable", sha, files: [] }, directory, procedure).pipe(
          Effect.provide(BunServices.layer),
        ),
      );
      expect(JSON.parse(readFileSync(join(directory, "docs-guidance.json"), "utf8"))).toEqual({
        status: "unavailable",
        sha,
        files: [],
      });
      expect(Bun.file(join(directory, "docs-guidance/README.md")).size).toBe(0);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("missing or corrupt snapshot reports unavailable rather than a style pass", () => {
    for (const snapshot of [null, {}, { status: "available", sha: "not-a-sha" }]) {
      expect(guidanceReviewStatus(snapshot)).toContain("guidance: unavailable");
    }
  });
});
