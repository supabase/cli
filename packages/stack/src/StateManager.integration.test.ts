import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NodeServices } from "@effect/platform-node";
import { describe, expect, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import { afterEach } from "vitest";
import type { AllocatedPorts } from "./PortAllocator.ts";
import {
  StateClaimError,
  StateManager,
  singleStackStateManagerPaths,
  type StackState,
} from "./StateManager.ts";

const tempRoots: string[] = [];

const ports: AllocatedPorts = {
  apiPort: 54321,
  dbPort: 54322,
  authPort: 54330,
  postgrestPort: 54331,
  postgrestAdminPort: 54332,
  edgeRuntimePort: 54338,
  edgeRuntimeInspectorPort: 54339,
  realtimePort: 54333,
  storagePort: 54334,
  imgproxyPort: 54335,
  mailpitPort: 54324,
  mailpitSmtpPort: 54325,
  mailpitPop3Port: 54326,
  pgmetaPort: 54336,
  studioPort: 54323,
  analyticsPort: 54327,
  poolerPort: 54329,
  poolerApiPort: 54337,
};

const state = (pid: number): StackState => ({
  pid,
  name: "claim-test",
  projectDir: "/project",
  apiPort: ports.apiPort,
  dbPort: ports.dbPort,
  ports,
  socketPath: "/runtime/daemon.sock",
  startedAt: "2026-08-04T00:00:00.000Z",
  url: "http://127.0.0.1:54321",
  dbUrl: "postgresql://postgres:postgres@127.0.0.1:54322/postgres",
  publishableKey: "publishable",
  secretKey: "secret",
  anonJwt: "anon",
  serviceRoleJwt: "service-role",
  serviceEndpoints: {},
  services: {},
});

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("StateManager claim", () => {
  it.live("allows exactly one daemon generation to publish state", () => {
    const root = mkdtempSync(join(tmpdir(), "stack-state-claim-"));
    tempRoots.push(root);
    const stackRoot = join(root, "stacks", "claim-test");
    const layer = StateManager.make(
      singleStackStateManagerPaths(stackRoot, join(root, "runtime"), "claim-test"),
    ).pipe(Layer.provide(NodeServices.layer));

    return Effect.gen(function* () {
      const manager = yield* StateManager;
      yield* manager.claim(state(100));

      const error = yield* manager.claim(state(200)).pipe(Effect.flip);
      expect(error).toBeInstanceOf(StateClaimError);
      expect(error.reason).toBe("already-claimed");
      expect((yield* manager.read("claim-test")).pid).toBe(100);
    }).pipe(Effect.provide(layer));
  });
});
