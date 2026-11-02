import { it } from "@effect/vitest";
import { Effect, Schema } from "effect";
import { describe, expect, test } from "vitest";
import {
  main,
  missingAssets,
  releaseAssets,
  uploadAssets,
  uploadedAssetNames,
  type ReleaseIo,
  type RetryPolicy,
  type RunResult,
} from "./upload-release-assets.ts";

const ok: RunResult = { exitCode: 0, stdout: "", stderr: "", timedOut: false };
const failed: RunResult = {
  exitCode: 1,
  stdout: "",
  stderr: "HTTP 500: Error saving asset\n",
  timedOut: false,
};
const timedOut: RunResult = { exitCode: null, stdout: "", stderr: "", timedOut: true };

const encodeJson = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));

const fastPolicy: RetryPolicy = {
  maxAttempts: 3,
  timeoutMs: 1_000,
  backoffMs: (failedAttempts) => failedAttempts * 10,
};

/** Fake IO that replays scripted results per asset path and records what the script did. */
function fakeIo(
  script: Record<string, RunResult[]> = {},
  options: { missingFiles?: string[] } = {},
) {
  const state = { runs: [] as string[][], sleeps: [] as number[], logs: [] as string[] };
  const io: ReleaseIo = {
    run: (argv) =>
      Effect.sync(() => {
        state.runs.push(argv);
        const target = (argv[2] === "upload" ? argv[4] : argv[3]) ?? "";
        return script[target]?.shift() ?? ok;
      }),
    fileExists: (path) => Effect.sync(() => !options.missingFiles?.includes(path)),
    sleep: (ms) =>
      Effect.sync(() => {
        state.sleeps.push(ms);
      }),
    log: (line) =>
      Effect.sync(() => {
        state.logs.push(line);
      }),
  };
  return { io, state };
}

describe("releaseAssets", () => {
  test("lists the versioned archives, packages, checksums, unversioned aliases, and install script", () => {
    const assets = releaseAssets("2.118.0-beta.60");
    const names = assets.map((asset) => asset.name);

    expect(assets).toHaveLength(22);
    expect(names).toContain("supabase_2.118.0-beta.60_darwin_arm64.tar.gz");
    expect(names).toContain("supabase_2.118.0-beta.60_linux_amd64.deb");
    expect(names).toContain("checksums.txt");
    expect(names).toContain("supabase_darwin_arm64.tar.gz");
    expect(names).toContain("install");
    expect(new Set(names).size).toBe(22);
    expect(assets.find((asset) => asset.name === "install")?.path).toBe("install");
  });
});

describe("uploadAssets", () => {
  const first = {
    path: "dist/supabase_1.0.0_darwin_arm64.tar.gz",
    name: "supabase_1.0.0_darwin_arm64.tar.gz",
  };
  const second = {
    path: "dist/supabase_1.0.0_linux_amd64.deb",
    name: "supabase_1.0.0_linux_amd64.deb",
  };
  const third = { path: "install", name: "install" };
  const assets = [first, second, third];

  it.effect("uploads every asset once with --clobber when nothing fails", () =>
    Effect.gen(function* () {
      const { io, state } = fakeIo();

      yield* uploadAssets("v1.0.0", assets, io, fastPolicy);

      expect(state.runs).toEqual(
        assets.map((asset) => ["gh", "release", "upload", "v1.0.0", asset.path, "--clobber"]),
      );
      expect(state.sleeps).toEqual([]);
      expect(state.logs.filter((line) => line.startsWith("Uploaded "))).toHaveLength(3);
    }),
  );

  it.effect("retries a failed asset with growing pauses and moves on once it lands", () =>
    Effect.gen(function* () {
      const { io, state } = fakeIo({ [second.path]: [failed, failed] });

      yield* uploadAssets("v1.0.0", assets, io, fastPolicy);

      const secondAttempts = state.runs.filter((argv) => argv[4] === second.path);
      expect(secondAttempts).toHaveLength(3);
      expect(state.sleeps).toEqual([10, 20]);
      expect(state.logs).toContain(
        `Upload of ${second.name} failed on attempt 1 (exit 1: HTTP 500: Error saving asset); retrying in 0.01s.`,
      );
      expect(state.logs).toContain(`Uploaded ${first.name} (attempt 1).`);
      expect(state.logs).toContain(`Uploaded ${second.name} (attempt 3).`);
    }),
  );

  it.effect("gives up on an asset after the last attempt and does not touch later assets", () =>
    Effect.gen(function* () {
      const { io, state } = fakeIo({ [second.path]: [failed, failed, failed] });

      const error = yield* Effect.flip(uploadAssets("v1.0.0", assets, io, fastPolicy));
      expect(error.message).toContain(
        `Upload of ${second.name} to v1.0.0 failed after 3 attempts (exit 1: HTTP 500: Error saving asset).`,
      );

      expect(state.runs.filter((argv) => argv[4] === third.path)).toHaveLength(0);
      expect(state.sleeps).toEqual([10, 20]);
    }),
  );

  it.effect("treats a timed-out upload as a failed attempt", () =>
    Effect.gen(function* () {
      const { io, state } = fakeIo({ [first.path]: [timedOut] });

      yield* uploadAssets("v1.0.0", [first], io, fastPolicy);

      expect(state.runs).toHaveLength(2);
      expect(state.logs[0]).toBe(
        `Upload of ${first.name} failed on attempt 1 (timed out after 1s); retrying in 0.01s.`,
      );
    }),
  );

  it.effect("fails before calling gh when an asset file is missing", () =>
    Effect.gen(function* () {
      const { io, state } = fakeIo({}, { missingFiles: [first.path] });

      const error = yield* Effect.flip(uploadAssets("v1.0.0", [first], io, fastPolicy));
      expect(error.message).toContain(`Release asset ${first.path} does not exist.`);
      expect(state.runs).toEqual([]);
    }),
  );
});

describe("uploadedAssetNames", () => {
  it.effect("keeps only assets GitHub reports as uploaded", () =>
    Effect.gen(function* () {
      const view = {
        assets: [
          { name: "checksums.txt", state: "uploaded" },
          { name: "install", state: "starter" },
        ],
      };
      const { io, state } = fakeIo({ "v1.0.0": [{ ...ok, stdout: yield* encodeJson(view) }] });

      expect(yield* uploadedAssetNames("v1.0.0", io)).toEqual(["checksums.txt"]);
      expect(state.runs).toEqual([["gh", "release", "view", "v1.0.0", "--json", "assets"]]);
    }),
  );

  it.effect("fails when the release cannot be read", () =>
    Effect.gen(function* () {
      const { io } = fakeIo({ "v1.0.0": [{ ...failed, stderr: "release not found\n" }] });

      const error = yield* Effect.flip(uploadedAssetNames("v1.0.0", io));
      expect(error.message).toContain(
        "Could not read assets of v1.0.0 (exit 1: release not found).",
      );
    }),
  );

  it.effect("names the release when gh prints something other than JSON", () =>
    Effect.gen(function* () {
      const { io } = fakeIo({ "v1.0.0": [{ ...ok, stdout: "gh: rate limited\n" }] });

      const error = yield* Effect.flip(uploadedAssetNames("v1.0.0", io));
      expect(error.message).toContain("Could not read assets of v1.0.0: gh returned invalid JSON.");
    }),
  );

  it.effect("names the release when the JSON has no usable assets array", () =>
    Effect.gen(function* () {
      const { io } = fakeIo({
        "v1.0.0": [{ ...ok, stdout: yield* encodeJson({ assets: [{ name: "install" }] }) }],
      });

      const error = yield* Effect.flip(uploadedAssetNames("v1.0.0", io));
      expect(error.message).toContain(
        "Could not read assets of v1.0.0: gh output has no assets array with name and state.",
      );
    }),
  );
});

describe("missingAssets", () => {
  test("returns the expected names that are absent, sorted", () => {
    expect(missingAssets(["b", "a", "c"], ["c"])).toEqual(["a", "b"]);
    expect(missingAssets(["a"], ["a", "extra"])).toEqual([]);
  });
});

describe("main", () => {
  const view = (names: string[]) => ({
    ...ok,
    stdout: JSON.stringify({ assets: names.map((name) => ({ name, state: "uploaded" })) }),
  });

  it.effect("prints usage for an unknown command or a missing version", () =>
    Effect.gen(function* () {
      const { io, state } = fakeIo();

      expect(yield* main(["publish", "--version", "1.0.0"], io)).toBe(2);
      expect(yield* main(["upload"], io)).toBe(2);
      expect(state.runs).toEqual([]);
      expect(state.logs[0]).toContain("Usage:");
    }),
  );

  it.effect("verify succeeds when every expected asset is uploaded", () =>
    Effect.gen(function* () {
      const names = releaseAssets("1.0.0").map((asset) => asset.name);
      const { io, state } = fakeIo({ "v1.0.0": [view(names)] });

      expect(yield* main(["verify", "--version", "1.0.0"], io)).toBe(0);
      expect(state.logs).toEqual(["All 22 expected assets are present on v1.0.0."]);
    }),
  );

  it.effect("verify fails and names each missing asset", () =>
    Effect.gen(function* () {
      const names = releaseAssets("1.0.0")
        .map((asset) => asset.name)
        .filter((name) => name !== "checksums.txt" && name !== "install");
      const { io, state } = fakeIo({ "v1.0.0": [view(names)] });

      expect(yield* main(["verify", "--version", "1.0.0"], io)).toBe(1);
      expect(state.logs).toEqual([
        "::error::Release v1.0.0 is missing assets or has incomplete uploads:",
        "  checksums.txt",
        "  install",
      ]);
    }),
  );
});
