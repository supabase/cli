// oxlint-disable effecttsgo/node-builtin-import, effecttsgo/prefer-schema-over-json -- Generated Vector configuration is a host-owned YAML boundary inspected as text.

import { NodeFileSystem } from "@effect/platform-node";
import { it } from "@effect/vitest";
import { Effect, FileSystem, Layer } from "effect";
import { describe, expect } from "vitest";
import { makeVectorServiceNative, prepareVectorConfig } from "./vector.ts";

describe("prepareVectorConfig", () => {
  it.effect("writes an isolated owning-stack source and sink configuration", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const runtimeRoot = yield* fs.makeTempDirectoryScoped({ prefix: "stack-vector-native-" });
      const prepared = yield* prepareVectorConfig({
        runtimeRoot,
        adminPort: 54333,
        analyticsPort: 54327,
        analyticsApiKey: "analytics-key",
      });
      const config = yield* fs.readFileString(prepared.configPath);
      const dataDirectoryExists = yield* fs.exists(prepared.dataDir);

      expect(prepared.configPath).toBe(`${runtimeRoot}/vector/vector.yaml`);
      expect(prepared.dataDir).toBe(`${runtimeRoot}/vector/data_dir`);
      expect(dataDirectoryExists).toBe(true);
      expect(config).toContain(`- "${runtimeRoot}/logs/*.jsonl"`);
      expect(config).toContain(`- "${runtimeRoot}/logs/*.jsonl.1"`);
      expect(config).toContain(`- "${runtimeRoot}/logs/*.jsonl.2"`);
      expect(config).toContain(`- "${runtimeRoot}/logs/*.jsonl.3"`);
      expect(config).toContain(`- "${runtimeRoot}/logs/vector.jsonl"`);
      expect(config).toContain(`- "${runtimeRoot}/logs/vector.jsonl.3"`);
      expect(config).toContain("codec: json");
      expect(config).toContain('uri: "http://127.0.0.1:54327/api/logs?source_name=postgres.logs"');
      expect(config).toContain('x-api-key: "analytics-key"');
      expect(config).toContain(`data_dir: "${runtimeRoot}/vector/data_dir"`);
      expect(config).toContain('address: "127.0.0.1:54333"');
      expect(config).not.toContain("docker_logs");

      const definition = makeVectorServiceNative({
        binPath: "/cache/vector/0.53.0/darwin-arm64",
        runtimeRoot,
        adminPort: 54333,
        analyticsPort: 54327,
        analyticsApiKey: "analytics-key",
        dependencies: [],
      });
      expect(definition.args).toEqual(["--config", prepared.configPath]);
    }).pipe(Effect.provide(Layer.mergeAll(NodeFileSystem.layer))),
  );
});
