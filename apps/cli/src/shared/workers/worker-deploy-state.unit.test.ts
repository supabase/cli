import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BunServices } from "@effect/platform-bun";
import { Effect, FileSystem, Option } from "effect";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
  readWorkerDeployState,
  workerDeployFingerprint,
  workerDeployUnchangedImage,
  writeWorkerDeployState,
  type WorkerDeployState,
} from "./worker-deploy-state.ts";
import type { WorkerDeploySpec, WorkerRecord } from "./workers-api.ts";

const SPEC: WorkerDeploySpec = {
  runtime: "node",
  size: "2gb-1vcpu",
  exposure: "public",
  instances: 1,
};

const FINGERPRINT = workerDeployFingerprint({ contentDigest: "sha256:abc", spec: SPEC });

function recordedState(overrides: Partial<WorkerDeployState> = {}): WorkerDeployState {
  return {
    worker: "api",
    project_ref: "abcdefghijklmnopqrst",
    fingerprint: FINGERPRINT,
    image_version: "v1",
    spec: SPEC,
    ...overrides,
  };
}

function remoteWorker(overrides: Partial<WorkerRecord> = {}): WorkerRecord {
  return {
    name: "api",
    spec: SPEC,
    buildState: "active",
    imageVersion: "v1",
    ...overrides,
  };
}

const verdict = (options: {
  recorded?: Option.Option<WorkerDeployState>;
  remote?: WorkerRecord;
  fingerprint?: string;
  spec?: WorkerDeploySpec;
}) =>
  workerDeployUnchangedImage({
    recorded: options.recorded ?? Option.some(recordedState()),
    remote: options.remote ?? remoteWorker(),
    fingerprint: options.fingerprint ?? FINGERPRINT,
    spec: options.spec ?? SPEC,
  });

describe("workerDeployFingerprint", () => {
  test("changes with the packaged contents", () => {
    expect(workerDeployFingerprint({ contentDigest: "sha256:def", spec: SPEC })).not.toBe(
      FINGERPRINT,
    );
  });

  // A worker whose code has not changed still has to be redeployed when the
  // shape it runs in has.
  test.each([
    ["size", { size: "4gb-2vcpu" }],
    ["instance count", { instances: 3 }],
    ["exposure", { exposure: "private" }],
    ["runtime", { runtime: "deno" }],
  ])("changes with the %s it would deploy under", (_label, change) => {
    expect(
      workerDeployFingerprint({ contentDigest: "sha256:abc", spec: { ...SPEC, ...change } }),
    ).not.toBe(FINGERPRINT);
  });

  // A Dockerfile worker sends no runtime at all, which has to be its own value
  // rather than reading as some runtime named later.
  test("tells an absent runtime from a named one", () => {
    const { runtime: _runtime, ...withoutRuntime } = SPEC;
    expect(workerDeployFingerprint({ contentDigest: "sha256:abc", spec: withoutRuntime })).not.toBe(
      FINGERPRINT,
    );
  });
});

describe("workerDeployUnchangedImage", () => {
  test("reports the running image when nothing has changed", () => {
    expect(verdict({})).toEqual(Option.some("v1"));
  });

  test("deploys when this CLI has no record of the worker", () => {
    expect(verdict({ recorded: Option.none() })).toEqual(Option.none());
  });

  test("deploys when the source or spec has changed since the record", () => {
    expect(verdict({ fingerprint: "sha256:something-else" })).toEqual(Option.none());
  });

  test.each([
    ["mid-build", { buildState: "building" as const }],
    ["failed", { buildState: "failed" as const }],
    ["being deleted", { deleting: true }],
  ])("deploys when the remote worker is %s", (_label, change) => {
    expect(verdict({ remote: remoteWorker(change) })).toEqual(Option.none());
  });

  // Someone redeployed from another checkout or the dashboard: the record says
  // nothing about what is running now.
  test("deploys when the running image is not the recorded one", () => {
    expect(verdict({ remote: remoteWorker({ imageVersion: "v7" }) })).toEqual(Option.none());
  });

  test.each([
    [
      "the record names no image",
      { recorded: Option.some(recordedState({ image_version: undefined })) },
    ],
    ["the API reports no image", { remote: remoteWorker({ imageVersion: undefined }) }],
  ])("deploys when %s", (_label, options) => {
    expect(verdict(options)).toEqual(Option.none());
  });

  // A rescale from the dashboard leaves the bundle alone but is still a change
  // this deploy would make.
  test.each([
    ["size", { size: "4gb-2vcpu" }],
    ["instance count", { instances: 4 }],
    ["exposure", { exposure: "private" }],
  ])("deploys when the API reports a different %s", (_label, change) => {
    expect(verdict({ remote: remoteWorker({ spec: { ...SPEC, ...change } }) })).toEqual(
      Option.none(),
    );
  });

  // Dockerfile workers deploy with no runtime in the spec, while the API
  // reports one regardless — comparing it would refuse to ever skip them.
  test("skips a Dockerfile worker the API reports a runtime for", () => {
    const { runtime: _runtime, ...dockerfileSpec } = SPEC;
    const fingerprint = workerDeployFingerprint({
      contentDigest: "sha256:abc",
      spec: dockerfileSpec,
    });

    expect(
      workerDeployUnchangedImage({
        recorded: Option.some(recordedState({ fingerprint, spec: dockerfileSpec })),
        remote: remoteWorker({ spec: { ...SPEC, runtime: "node" } }),
        fingerprint,
        spec: dockerfileSpec,
      }),
    ).toEqual(Option.some("v1"));
  });
});

describe("worker deploy state on disk", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "supabase-worker-state-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const key = () => ({ projectRoot: dir, projectRef: "abcdefghijklmnopqrst", name: "api" });
  const run = <A, E>(effect: Effect.Effect<A, E, FileSystem.FileSystem>) =>
    Effect.runPromise(effect.pipe(Effect.provide(BunServices.layer)));

  const statePath = () =>
    join(dir, "supabase", ".temp", "workers", "abcdefghijklmnopqrst", "api.json");

  test("reads back what it wrote", async () => {
    await run(writeWorkerDeployState(key(), recordedState()));

    expect(await run(readWorkerDeployState(key()))).toEqual(Option.some(recordedState()));
  });

  test("keeps one record per project ref", async () => {
    await run(writeWorkerDeployState(key(), recordedState()));

    const otherRef = { ...key(), projectRef: "tsrqponmlkjihgfedcba" };
    expect(await run(readWorkerDeployState(otherRef))).toEqual(Option.none());
  });

  test("reads nothing when no deploy has been recorded", async () => {
    expect(await run(readWorkerDeployState(key()))).toEqual(Option.none());
  });

  // A file half-written by a killed process, edited by hand, or left by a newer
  // CLI costs a redeploy — never a failed command.
  test.each([
    ["unparseable", "{ not json"],
    ["the wrong shape", JSON.stringify({ worker: "api" })],
  ])("reads nothing from a record that is %s", async (_label, contents) => {
    mkdirSync(join(dir, "supabase", ".temp", "workers", "abcdefghijklmnopqrst"), {
      recursive: true,
    });
    writeFileSync(statePath(), contents);

    expect(await run(readWorkerDeployState(key()))).toEqual(Option.none());
  });
});
