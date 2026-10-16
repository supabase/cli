import { Effect } from "effect";
import { databaseArtifactPin, defaultArtifactSelection } from "../src/Artifacts.ts";

/** The compiled default pin of every service kind. */
export const selection = defaultArtifactSelection();

/** The PostgreSQL 15 database pin, the non-default stock line. */
export const database15 = Effect.runSync(databaseArtifactPin("15"));

/** The OrioleDB database pin. */
export const orioledb = Effect.runSync(databaseArtifactPin("17.11.0.002-orioledb"));
