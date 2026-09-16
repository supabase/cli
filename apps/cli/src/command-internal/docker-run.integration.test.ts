import { describe, expect, it } from "@effect/vitest";
import { ConfigProvider, Effect, Layer, Option } from "effect";

import { mockChildProcessSpawner } from "../../tests/helpers/child-process-spawner.ts";
import { mockProcessControl } from "../../tests/helpers/mocks.ts";
import { dockerRunLayer } from "./docker-run.layer.ts";
import { DockerRun, type DockerRunOpts } from "./docker-run.service.ts";

const options: DockerRunOpts = {
  image: "postgres:17",
  cmd: [],
  env: {},
  binds: ["project-cache:/cache", "/tmp/project:/project"],
  workingDir: Option.none(),
  securityOpt: ["label:disable"],
  extraHosts: [],
  network: { _tag: "none" },
  skipImageResolve: true,
};

describe("DockerRun project configuration", () => {
  it.live("keeps one project's Bitbucket restrictions out of the next run", () => {
    const child = mockChildProcessSpawner();
    const layer = dockerRunLayer.pipe(
      Layer.provide(child.layer),
      Layer.provide(mockProcessControl().layer),
    );
    return Effect.gen(function* () {
      const docker = yield* DockerRun;
      yield* docker.run({
        ...options,
        projectEnvValues: { BITBUCKET_CLONE_DIR: "/pipeline/project" },
      });
      yield* docker.run({ ...options, projectEnvValues: {} });

      expect(child.spawned).toHaveLength(2);
      expect(child.spawned[0]?.args).not.toContain("project-cache:/cache");
      expect(child.spawned[0]?.args).not.toContain("--security-opt");
      expect(child.spawned[0]?.args).toContain("/tmp/project:/project");
      expect(child.spawned[1]?.args).toContain("project-cache:/cache");
      expect(child.spawned[1]?.args).toContain("--security-opt");
    }).pipe(
      Effect.provide(layer),
      Effect.provideService(
        ConfigProvider.ConfigProvider,
        ConfigProvider.fromEnvRecord({}, { preserveEmptyStrings: true }),
      ),
    );
  });

  it.live(
    "reads ambient settings per invocation and retains an explicit empty project value",
    () => {
      const child = mockChildProcessSpawner();
      const ambient: Record<string, string> = { BITBUCKET_CLONE_DIR: "/pipeline/ambient" };
      const layer = dockerRunLayer.pipe(
        Layer.provide(child.layer),
        Layer.provide(mockProcessControl().layer),
      );
      return Effect.gen(function* () {
        const docker = yield* DockerRun;
        yield* docker.runStream(
          { ...options, projectEnvValues: {} },
          { onStdout: () => Effect.void },
        );
        yield* docker.runCapture({ ...options, projectEnvValues: { BITBUCKET_CLONE_DIR: "" } });
        ambient.BITBUCKET_CLONE_DIR = "";
        yield* docker.runCapture(options);

        expect(child.spawned).toHaveLength(3);
        expect(child.spawned[0]?.args).not.toContain("--security-opt");
        expect(child.spawned[1]?.args).toContain("--security-opt");
        expect(child.spawned[2]?.args).toContain("--security-opt");
      }).pipe(
        Effect.provide(layer),
        Effect.provideService(
          ConfigProvider.ConfigProvider,
          ConfigProvider.fromEnvRecord(ambient, { preserveEmptyStrings: true }),
        ),
      );
    },
  );
});
