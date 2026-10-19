import { BunServices } from "@effect/platform-bun";
import { Effect, FileSystem, Layer, Path } from "effect";

import { commandRuntimeLayer } from "../../src/shared/runtime/command-runtime.layer.ts";
import { COMPUTE_PROJECT_REF, setupCompute } from "./compute.ts";
import type { ComputeHttpRoutes } from "./compute.ts";
import { describeTargetSelectionMatrix } from "./hosted-target-selection.ts";
import type { TargetSelectionFlags } from "./hosted-target-selection.ts";
import type { ActiveFlags } from "./permission-registry.ts";
import { branchRow, warningsOf } from "./remote-selection.ts";

type ComputeSetup = ReturnType<typeof setupCompute>;

/** Everything a compute leaf's handler can require while `describeComputeTargetSelection` runs it. */
type ComputeTargetSelectionServices = Layer.Success<ComputeSetup["layer"]>;

export interface ComputeTargetSelectionScenario {
  readonly operands?: ReadonlyArray<string>;
  /** Files the leaf reads from the project directory, relative to it. */
  readonly files?: Readonly<Record<string, string>>;
  /** The routes the leaf calls on the project it acts on; the harness adds the branch lookup. */
  readonly routes: (ref: string) => ComputeHttpRoutes;
  readonly run: (
    flags: TargetSelectionFlags,
  ) => Effect.Effect<unknown, unknown, ComputeTargetSelectionServices>;
  readonly activeFlags?: ActiveFlags;
}

const writeFiles = (workdir: string, files: Readonly<Record<string, string>>) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    for (const [relativePath, contents] of Object.entries(files)) {
      const absolutePath = path.join(workdir, relativePath);
      yield* fs.makeDirectory(path.dirname(absolutePath), { recursive: true });
      yield* fs.writeFileString(absolutePath, contents);
    }
  }).pipe(Effect.provide(BunServices.layer));

/** `describeTargetSelectionMatrix` for a `compute` leaf, whose runtime is `setupCompute` over stubbed routes. */
export function describeComputeTargetSelection(
  path: string,
  scenario: ComputeTargetSelectionScenario,
): void {
  describeTargetSelectionMatrix<ComputeTargetSelectionServices>(path, {
    mode: "project",
    operands: scenario.operands ?? [],
    ...(scenario.activeFlags === undefined ? {} : { activeFlags: scenario.activeFlags }),
    variant: { computeEnabled: true },
    run: scenario.run,
    prepare: (workdir) => writeFiles(workdir, scenario.files ?? {}),
    linkParent: (workdir) =>
      writeFiles(workdir, { "supabase/.temp/project-ref": COMPUTE_PROJECT_REF }),
    harness: ({ selectorArgs, expectedRef, workdir }) => {
      const { out, http, layer } = setupCompute({
        workdir,
        cliArgs: selectorArgs,
        yes: true,
        routes: {
          ...scenario.routes(expectedRef),
          [`GET /v1/projects/${COMPUTE_PROJECT_REF}/branches`]: {
            status: 200,
            body: [branchRow("feature-x")],
          },
        },
      });
      return {
        layer: Layer.mergeAll(
          layer,
          commandRuntimeLayer(path.split(" ")).pipe(Layer.provide(BunServices.layer)),
        ),
        requests: () => http.driftRequests,
        warnings: () => warningsOf(out),
      };
    },
  });
}
