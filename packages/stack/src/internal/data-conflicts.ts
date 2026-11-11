import { Effect } from "effect";
import type { FileSystem, Path } from "effect";
import type { ArtifactSelection } from "../Artifacts.ts";
import type { SavedStack } from "../StackNamespace.ts";
import {
  DatabaseDataState,
  databaseIdentityMismatch,
  readDatabaseDataState,
  readDatabaseIdentity,
} from "./database-reuse.ts";
import {
  boundDatabaseId,
  readSchemaWriters,
  schemaWriterDowngrade,
  schemaWriterServices,
  type SchemaWriterService,
} from "./schema-writers.ts";

/**
 * Saved data in database instance `instanceId` that a start at the requested pins would refuse,
 * with the failure a start reports (`message`). `recorded` is `undefined` when the data has no
 * identity.
 */
export type DataConflict =
  | {
      readonly kind: "database-build";
      readonly stackId: string;
      readonly service: "database";
      readonly instanceId: string;
      readonly recorded: string | undefined;
      readonly requested: string;
      readonly message: string;
    }
  | {
      readonly kind: "schema-downgrade";
      readonly stackId: string;
      readonly service: SchemaWriterService;
      readonly instanceId: string;
      readonly recorded: string;
      readonly requested: string;
      readonly message: string;
    };

/**
 * The conflicts `requested` would meet in a saved stack's data under `dataRoot`, judged by the
 * rules a start applies: initialized data per its runtime, the identity a container runtime
 * recorded before an interrupted first start, and the schema writers the composition binds to each
 * database.
 */
export const collectDataConflicts = Effect.fn("DataConflicts.find")(function* (
  fs: FileSystem.FileSystem,
  path: Path.Path,
  options: {
    readonly saved: Pick<SavedStack, "id" | "runtime" | "instances" | "composition">;
    readonly dataRoot: string;
    readonly requested: Partial<ArtifactSelection>;
  },
) {
  const { saved, dataRoot, requested } = options;
  const serviceOf = (id: string) =>
    saved.instances.find((instance) => instance.id === id)?.creation.service;
  const conflicts: Array<DataConflict> = [];
  for (const { id: databaseId } of saved.instances.filter(
    ({ creation }) => creation.service === "database",
  )) {
    const instanceRoot = path.join(dataRoot, databaseId);
    const databasePin = requested.database;
    if (databasePin !== undefined) {
      const state = yield* readDatabaseDataState(fs, path, instanceRoot, saved.runtime);
      const initialized = DatabaseDataState.$is("Initialized")(state);
      // A container volume is invisible to the host; a start's prepare judges the identity recorded
      // before initdb whenever the volume holds PG_VERSION.
      const maybeInVolume = DatabaseDataState.$is("Fresh")(state) && saved.runtime !== "native";
      const recorded =
        initialized || maybeInVolume
          ? yield* readDatabaseIdentity(fs, path, instanceRoot)
          : undefined;
      const mismatch =
        initialized || recorded !== undefined
          ? databaseIdentityMismatch(saved.id, recorded, databasePin.upstreamVersion)
          : undefined;
      if (mismatch !== undefined)
        conflicts.push({
          kind: "database-build",
          stackId: saved.id,
          service: "database",
          instanceId: databaseId,
          recorded: mismatch.recorded?.build,
          requested: mismatch.requested.build,
          message: mismatch.message,
        });
    }
    const writers = yield* readSchemaWriters(fs, path, instanceRoot);
    for (const service of schemaWriterServices) {
      const pin = requested[service];
      const bound = saved.instances.some(
        ({ id, creation }) =>
          creation.service === service &&
          boundDatabaseId(saved.composition.dependencies, serviceOf, id) === databaseId,
      );
      const downgrade =
        pin === undefined || !bound
          ? undefined
          : schemaWriterDowngrade(saved.id, writers, service, pin.upstreamVersion);
      if (downgrade !== undefined)
        conflicts.push({
          kind: "schema-downgrade",
          stackId: saved.id,
          service,
          instanceId: databaseId,
          recorded: downgrade.recorded,
          requested: downgrade.selected,
          message: downgrade.message,
        });
    }
  }
  yield* Effect.annotateCurrentSpan({ "data_conflicts.count": conflicts.length });
  return conflicts;
});
