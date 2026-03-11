import { homedir } from "node:os";
import process from "node:process";
import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";
import { RuntimeInfo } from "./runtime-info.service.ts";
import { runtimeInfoLayer } from "./runtime-info.layer.ts";

describe("RuntimeInfo", () => {
  it.effect("reads runtime information from node:process and node:os", () =>
    Effect.gen(function* () {
      const runtimeInfo = yield* RuntimeInfo;
      expect(runtimeInfo.cwd).toBe(process.cwd());
      expect(runtimeInfo.platform).toBe(process.platform);
      expect(runtimeInfo.arch).toBe(process.arch);
      expect(runtimeInfo.homeDir).toBe(homedir());
      expect(runtimeInfo.execPath).toBe(process.execPath);
      expect(runtimeInfo.pid).toBe(process.pid);
    }).pipe(Effect.provide(runtimeInfoLayer)),
  );
});
