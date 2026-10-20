import { Record } from "effect";
import type { ArtifactPin } from "../src/Artifacts.ts";
import { LOCK_SCHEMA_URL, type Lock } from "../src/Lock.ts";
import { selection } from "./pins.ts";

/** A full lock of the bundled pins, with the database pinned to `database`. */
export const lockWithDatabase = (database: ArtifactPin, majorVersion: number): Lock => ({
  $schema: LOCK_SCHEMA_URL,
  lockfileVersion: 1,
  services: {
    ...Record.map(selection, (resolved) => ({
      specifier: "bundled",
      resolution: "resolved" as const,
      resolved,
    })),
    database: {
      specifier: "bundled",
      resolution: "resolved",
      resolved: database,
      majorVersion,
      line: "stock",
    },
  },
});
