import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, test } from "vitest";
import {
  makeTempCliProject,
  makeTempHome,
  runSupabase,
  spawnSupabase,
} from "../../tests/helpers/cli.ts";

describe("CLI feature routing", () => {
  test("reports invalid stack feature configuration during completion", async () => {
    const project = await makeTempCliProject("supabase-main-routing-e2e-");
    const home = makeTempHome();
    try {
      const result = await runSupabase(["__complete", "start", "--"], {
        cwd: project.dir,
        home: home.dir,
        env: {
          SUPABASE_EXPERIMENTAL_STACK: "yes",
          SUPABASE_WORKDIR: undefined,
        },
      });

      expect(result.exitCode).toBe(1);
      expect(result.stdout).toBe("");
      expect(result.stderr).toContain("SUPABASE_EXPERIMENTAL_STACK must be 0 or 1");
    } finally {
      await project.cleanup();
      home[Symbol.dispose]();
    }
  });
});

describe("CLI output to a closed pipe", () => {
  const runWithFakeApi = async (
    args: string[],
    options: {
      readonly holdRequests?: boolean;
      readonly closedPipe?: "stdout" | "stderr";
      readonly env?: Record<string, string>;
    } = {},
  ) => {
    const { promise: released, resolve: release } = Promise.withResolvers<void>();
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: async () => {
        if (options.holdRequests) await released;
        return Response.json([]);
      },
    });
    const home = makeTempHome();
    try {
      const profilePath = path.join(home.dir, "closed-pipe-profile.yaml");
      await writeFile(
        profilePath,
        [
          "name: closed-pipe-e2e",
          `api_url: "${server.url.origin}"`,
          `dashboard_url: "${server.url.origin}"`,
          'project_host: "example.invalid"',
          "",
        ].join("\n"),
      );

      return await spawnSupabase(args, {
        cwd: home.dir,
        home: home.dir,
        closedPipe: options.closedPipe,
        exitTimeoutMs: 30_000,
        env: {
          SUPABASE_ACCESS_TOKEN: `sbp_${"a".repeat(40)}`,
          SUPABASE_PROFILE: profilePath,
          ...options.env,
        },
      }).waitForExit();
    } finally {
      release();
      await server.stop(true);
      home[Symbol.dispose]();
    }
  };

  // The `projects list` rows hit the closed pipe in the output sink: stdout with the payload, stderr
  // with the not-linked notice. The completion row reaches an unmanaged stderr write before any
  // command runs.
  test.skipIf(process.platform === "win32").each<{
    readonly pipe: "stdout" | "stderr";
    readonly args: string;
    readonly env?: Record<string, string>;
  }>([
    { pipe: "stdout", args: "projects list -o json" },
    { pipe: "stdout", args: "projects list --output-format json" },
    { pipe: "stderr", args: "projects list -o json" },
    { pipe: "stderr", args: "__complete start --", env: { SUPABASE_EXPERIMENTAL_STACK: "yes" } },
  ])("exits with 141 when $pipe is a closed pipe ($args)", async ({ pipe, args, ...options }) => {
    const result = await runWithFakeApi(args.split(" "), { ...options, closedPipe: pipe });

    expect(result.exitCode, result.stdout + result.stderr).toBe(141);
  });

  test.skipIf(process.platform === "win32")(
    "runs the command's cleanup before it exits 141",
    async () => {
      const traceDir = makeTempHome();
      try {
        const tracePath = path.join(traceDir.dir, "trace.jsonl");
        const result = await runWithFakeApi(["projects", "list"], {
          holdRequests: true,
          closedPipe: "stdout",
          env: { SUPABASE_TRACE_FILE: tracePath },
        });

        expect(result.exitCode, result.stderr).toBe(141);
        // `cli.run` is exported last, once the interrupted command's own finalizers have run.
        expect(await readFile(tracePath, "utf8")).toContain(
          '"key":"process.exit_code","value":{"intValue":141}',
        );
      } finally {
        traceDir[Symbol.dispose]();
      }
    },
  );

  test("prints the projects to a drained stdout", async () => {
    const result = await runWithFakeApi(["projects", "list", "-o", "json"]);

    expect(result.exitCode, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual([]);
  });
});
