import { BunRuntime, BunServices } from "@effect/platform-bun";
import { Config, Console, Data, Effect, FileSystem, Path, Schema, Stream } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { Baseline, type MachineOutput } from "./machine-output.ts";
import { runCase } from "./scenario.ts";
import { scenarios } from "./scenarios.ts";

class RecordError extends Data.TaggedError("RecordError")<{ readonly message: string }> {}

const encodeBaseline = Schema.encodeEffect(Schema.fromJsonString(Baseline, { space: 2 }));
const usage =
  "Usage: bun apps/cli/tests/migration-compat/record.ts <scenario> <git-revision> [--output <new-file>]";

const record = Effect.fn("MigrationCompat.record")(function* () {
  for (const key of ["CI", "CONTINUOUS_INTEGRATION", "GITHUB_ACTIONS"]) {
    if (yield* Config.String(key).pipe(Config.withDefault(""))) {
      return yield* new RecordError({
        message: "Baseline recording is local only; CI must verify.",
      });
    }
  }
  const [name, ref, flag, output] = Bun.argv.slice(2);
  if (
    !name ||
    !ref ||
    (Bun.argv.length !== 4 && (Bun.argv.length !== 6 || flag !== "--output" || !output))
  ) {
    return yield* new RecordError({ message: usage });
  }
  const scenario = scenarios.find((entry) => entry.name === name);
  if (!scenario) return yield* new RecordError({ message: `Unknown scenario: ${name}` });
  const { dirname, join, resolve } = yield* Path.Path;
  const repo = resolve(import.meta.dir, "../../../..");
  const target = output ? resolve(output) : join(import.meta.dir, `${scenario.name}.baseline.json`);
  const fs = yield* FileSystem.FileSystem;
  if (yield* fs.exists(target)) {
    return yield* new RecordError({
      message: `Refusing to overwrite ${target}; use --output with a new file.`,
    });
  }
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const path = yield* Config.String("PATH");
  const env = {
    PATH: path,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_NO_LAZY_FETCH: "1",
  };
  const run = Effect.fn("MigrationCompat.runBuildCommand")(function* (
    exe: string,
    args: readonly string[],
    cwd: string,
    childEnv: Record<string, string>,
    capture = false,
  ) {
    const child = yield* spawner.spawn(
      ChildProcess.make(exe, args, {
        cwd,
        env: childEnv,
        extendEnv: false,
        stdin: "ignore",
        stderr: "inherit",
        stdout: capture ? "pipe" : "inherit",
      }),
    );
    const [stdout, code] = yield* Effect.all(
      [
        capture ? child.stdout.pipe(Stream.decodeText(), Stream.mkString) : Effect.succeed(""),
        child.exitCode,
      ],
      { concurrency: "unbounded" },
    );
    yield* Effect.annotateCurrentSpan({ "process.exit_code": code });
    if (code !== 0)
      return yield* new RecordError({ message: `${exe} ${args[0]} failed (exit ${code}).` });
    return stdout.trim();
  }, Effect.scoped);
  const revision = yield* run(
    "git",
    ["rev-parse", "--verify", "--end-of-options", `${ref}^{commit}`],
    repo,
    env,
    true,
  );
  const storeHome = yield* Config.String("HOME");
  const localPnpmEnv = {
    PATH: path,
    NPM_CONFIG_USERCONFIG: "/dev/null",
    NPM_CONFIG_GLOBALCONFIG: "/dev/null",
    COREPACK_ENABLE_NETWORK: "0",
    HTTP_PROXY: "http://127.0.0.1:1",
    HTTPS_PROXY: "http://127.0.0.1:1",
  };
  const store = yield* run(
    "pnpm",
    ["store", "path"],
    repo,
    { ...localPnpmEnv, HOME: storeHome },
    true,
  );
  const temp = yield* fs.makeTempDirectoryScoped({ prefix: "migration-compat-build-" });
  const source = join(temp, "source");
  const home = join(temp, "home");
  yield* fs.makeDirectory(source);
  yield* fs.makeDirectory(home);
  const buildEnv = {
    ...localPnpmEnv,
    HOME: home,
    TMPDIR: temp,
    XDG_CONFIG_HOME: home,
    XDG_CACHE_HOME: home,
  };
  yield* Console.log(`Building ${revision} from a temporary Git archive`);
  const archive = join(temp, "source.tar");
  yield* run("git", ["archive", "--format=tar", `--output=${archive}`, revision], repo, env);
  yield* run("tar", ["-xf", archive], source, buildEnv);
  yield* run(
    "pnpm",
    [
      "install",
      "--offline",
      "--frozen-lockfile",
      "--ignore-scripts",
      "--trust-lockfile",
      `--store-dir=${store}`,
    ],
    source,
    buildEnv,
  );
  const cli = join(source, "apps/cli");
  yield* run("pnpm", ["build:binary"], cli, buildEnv);
  const cases: Record<string, MachineOutput> = {};
  for (const testCase of scenario.cases) {
    cases[testCase.name] = yield* runCase(join(cli, "dist/supabase"), scenario, testCase);
  }
  // Publish only a complete file, and fail even if another recorder created the target during the build.
  const staging = yield* fs.makeTempDirectoryScoped({
    directory: dirname(target),
    prefix: ".migration-compat-",
  });
  const candidate = join(staging, "baseline.json");
  yield* fs.writeFileString(
    candidate,
    `${yield* encodeBaseline({ revision, argv: scenario.argv, cases })}\n`,
  );
  yield* fs.link(candidate, target);
  yield* Console.log(`Recorded ${scenario.cases.length} cases in ${target}`);
}, Effect.scoped);

BunRuntime.runMain(record().pipe(Effect.provide(BunServices.layer)));
