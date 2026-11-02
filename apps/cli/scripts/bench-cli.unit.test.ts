import { describe, expect, it } from "@effect/vitest";
import { BunServices } from "@effect/platform-bun";
import { Effect } from "effect";
import {
  buildRunPlan,
  buildUnitPlan,
  isolatedEnv,
  parseBenchArgs,
  profileYaml,
  resolveWorkloads,
  wantsHelp,
} from "./bench-cli.ts";

const required = ["--base", "/bin/a", "--branch", "/bin/b"];

describe("parseBenchArgs", () => {
  it("accepts commands that start with a dash and keeps update checks off by default", () => {
    const options = parseBenchArgs([
      ...required,
      "--command",
      "--version",
      "--command",
      "db diff --local",
    ]);

    expect(options.commands).toEqual([["--version"], ["db", "diff", "--local"]]);
    expect(options.updateCheck).toBe(false);
  });

  it("rejects a manifest combined with --command or --cwd-setup", () => {
    expect(() =>
      parseBenchArgs([...required, "--workloads", "w.json", "--command", "init"]),
    ).toThrow("--workloads cannot be combined");
    expect(() =>
      parseBenchArgs([...required, "--workloads", "w.json", "--cwd-setup", "init"]),
    ).toThrow("--workloads cannot be combined");
  });

  it("requires --trace with --api-url because call counts come from the trace", () => {
    expect(() => parseBenchArgs([...required, "--api-url", "http://127.0.0.1:1"])).toThrow(
      "--api-url requires --trace",
    );
    expect(parseBenchArgs([...required, "--api-url", "http://127.0.0.1:1", "--trace"]).apiUrl).toBe(
      "http://127.0.0.1:1",
    );
  });
});

describe("resolveWorkloads", () => {
  it.effect.each([
    { cwdSetup: ["--cwd-setup", "init"], expected: "init" },
    { cwdSetup: [], expected: "none" },
  ])("turns --command entries into workloads with cwdSetup $expected", ({ cwdSetup, expected }) =>
    Effect.gen(function* () {
      const options = parseBenchArgs([
        ...required,
        "--command",
        "migration new bench",
        ...cwdSetup,
      ]);

      const workloads = yield* resolveWorkloads(options);

      expect(workloads).toEqual([
        { id: "migration new bench", args: ["migration", "new", "bench"], cwdSetup: expected },
      ]);
    }).pipe(Effect.provide(BunServices.layer)),
  );
});

describe("resolveWorkloads validation", () => {
  it.effect("fails with a WorkloadValidationError carrying the problems", () =>
    Effect.gen(function* () {
      const options = parseBenchArgs([
        ...required,
        "--command",
        "migration new bench",
        "--command",
        "migration new bench",
      ]);

      const error = yield* resolveWorkloads(options).pipe(Effect.flip);

      const problems = error._tag === "WorkloadValidationError" ? error.problems : undefined;
      expect(problems).toEqual(['duplicate workload id "migration new bench"']);
    }).pipe(Effect.provide(BunServices.layer)),
  );
});

describe("wantsHelp", () => {
  it("treats --help as a flag only when it is not a --command value", () => {
    expect(wantsHelp(["--help"])).toBe(true);
    expect(wantsHelp([...required, "--command", "--help"])).toBe(false);
  });
});

describe("buildRunPlan", () => {
  it("swaps the launch order every other iteration and discards the first warmup iterations", () => {
    const plan = buildRunPlan(2, 1);

    expect(plan.map((run) => [run.build, run.warmup])).toEqual([
      ["branch", true],
      ["base", true],
      ["base", false],
      ["branch", false],
      ["branch", false],
      ["base", false],
    ]);
  });
});

describe("buildUnitPlan", () => {
  it("gives a run-scoped workload one launch per unit in the order buildRunPlan chooses", () => {
    const plan = buildUnitPlan(2, 1, "run");

    expect(plan.map((unit) => [unit.build, ...unit.launches])).toEqual([
      ["branch", "warmup"],
      ["base", "warmup"],
      ["base", "timed"],
      ["branch", "timed"],
      ["branch", "timed"],
      ["base", "timed"],
    ]);
  });

  it("splits a block-scoped workload into blocks of measured launches after the warmup launches, swapping the first build every other block", () => {
    const plan = buildUnitPlan(7, 1, "block", 5);

    expect(plan.map((unit) => unit.build)).toEqual(["base", "branch", "branch", "base"]);
    const measured = (build: "base" | "branch") =>
      plan
        .filter((unit) => unit.build === build)
        .map((unit) => unit.launches.filter((kind) => kind === "timed").length);
    expect(measured("base")).toEqual([5, 2]);
    expect(measured("branch")).toEqual([5, 2]);
    expect(plan[0]?.launches).toEqual(["warmup", "timed", "timed", "timed", "timed", "timed"]);
  });
});

describe("parseBenchArgs for stack runs", () => {
  it("lets explicit --runs and --warmup override the manifest, and defaults otherwise", () => {
    expect(parseBenchArgs(required)).toMatchObject({
      runs: 10,
      warmup: 2,
      runsExplicit: false,
      warmupExplicit: false,
    });
    expect(parseBenchArgs([...required, "--runs", "3", "--warmup", "0"])).toMatchObject({
      runs: 3,
      warmup: 0,
      runsExplicit: true,
      warmupExplicit: true,
    });
  });

  it("reads --only, --runtime and a resolved --artifact-cache", () => {
    const options = parseBenchArgs([
      ...required,
      "--only",
      "a,b",
      "--runtime",
      "native",
      "--artifact-cache",
      "/tmp/cache",
    ]);

    expect(options).toMatchObject({
      only: ["a", "b"],
      runtime: "native",
      artifactCache: "/tmp/cache",
    });
  });

  it("rejects an unknown runtime", () => {
    expect(() => parseBenchArgs([...required, "--runtime", "podman"])).toThrow("--runtime");
  });
});

describe("profileYaml", () => {
  it("points the API and dashboard at the replay server and keeps project hosts local", () => {
    const yaml = profileYaml("http://127.0.0.1:9");

    expect(yaml).toContain('api_url: "http://127.0.0.1:9"');
    expect(yaml).toContain('dashboard_url: "http://127.0.0.1:9"');
    expect(yaml).toContain("project_host: localhost");
  });
});

describe("isolatedEnv", () => {
  it("strips SUPABASE_*, OTEL_*, and TRACEPARENT while keeping other ambient variables", () => {
    const ambient = {
      HOME: "/home/person",
      PATH: "/usr/bin",
      SUPABASE_ACCESS_TOKEN: "secret",
      SUPABASE_API_URL: "https://elsewhere",
      OTEL_EXPORTER_OTLP_ENDPOINT: "http://collector",
      TRACEPARENT: "00-...-01",
    };

    expect(isolatedEnv(ambient, { SUPABASE_HOME: "/tmp/home", DO_NOT_TRACK: "1" })).toEqual({
      HOME: "/home/person",
      PATH: "/usr/bin",
      SUPABASE_HOME: "/tmp/home",
      DO_NOT_TRACK: "1",
    });
  });
});
