import { describe, expect, it } from "@effect/vitest";
import { BunServices } from "@effect/platform-bun";
import { Effect } from "effect";
import {
  buildRunPlan,
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
      ["base", true],
      ["branch", true],
      ["branch", false],
      ["base", false],
      ["base", false],
      ["branch", false],
    ]);
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
