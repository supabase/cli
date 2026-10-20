import { expect, it } from "@effect/vitest";
import {
  databaseDataState,
  databaseIdentity,
  databaseIdentityMismatch,
  type DatabaseReadyMarker,
} from "./database-reuse.ts";

const STOCK_17 = "17.6.1.054";
const STOCK_17_NEWER = "17.6.1.060";
const STOCK_15 = "15.8.1.085";
const ORIOLEDB_17 = "17.11.0.002-orioledb";
const ORIOLEDB_17_NEWER = "17.11.0.004-orioledb";

const destroy =
  "run `supabase stack destroy --stack-id stack-a` to recreate the stack — this permanently deletes its local database data";

const messageFor = (recorded: string | undefined, requested: string) =>
  databaseIdentityMismatch(
    "stack-a",
    recorded === undefined ? undefined : databaseIdentity(recorded),
    requested,
  )?.message;

it("offers to keep data by pinning its build when the major and line are unchanged", () => {
  expect(messageFor(STOCK_17, STOCK_17_NEWER)).toBe(
    `PostgreSQL data was initialized by stock PostgreSQL build ${STOCK_17}, but stock PostgreSQL build ${STOCK_17_NEWER} was requested; keep this data by pinning \`[local.services.database] version = "${STOCK_17}"\` in supabase/config.toml, or ${destroy}`,
  );
});

it("offers to restore the recorded major beside the pin when the major differs", () => {
  expect(messageFor(STOCK_15, STOCK_17)).toBe(
    `PostgreSQL data was initialized by stock PostgreSQL build ${STOCK_15}, but stock PostgreSQL build ${STOCK_17} was requested; keep this data by pinning \`[local.services.database] version = "${STOCK_15}"\` and setting \`[db] major_version = 15\` in supabase/config.toml, or ${destroy}`,
  );
});

it("offers to remove any orioledb_version when stock data is asked for an OrioleDB build of the same major", () => {
  expect(messageFor(STOCK_17, ORIOLEDB_17)).toBe(
    `PostgreSQL data was initialized by stock PostgreSQL build ${STOCK_17}, but OrioleDB build ${ORIOLEDB_17} was requested; keep this data by pinning \`[local.services.database] version = "${STOCK_17}"\` and removing any \`[db] orioledb_version\` in supabase/config.toml, or ${destroy}`,
  );
});

it("offers only the pin when OrioleDB data is asked for a stock build of the same major", () => {
  expect(messageFor(ORIOLEDB_17, STOCK_17)).toBe(
    `PostgreSQL data was initialized by OrioleDB build ${ORIOLEDB_17}, but stock PostgreSQL build ${STOCK_17} was requested; keep this data by pinning \`[local.services.database] version = "${ORIOLEDB_17}"\` in supabase/config.toml, or ${destroy}`,
  );
});

it("offers to remove any orioledb_version when OrioleDB data is asked for another OrioleDB build", () => {
  expect(messageFor(ORIOLEDB_17, ORIOLEDB_17_NEWER)).toBe(
    `PostgreSQL data was initialized by OrioleDB build ${ORIOLEDB_17}, but OrioleDB build ${ORIOLEDB_17_NEWER} was requested; keep this data by pinning \`[local.services.database] version = "${ORIOLEDB_17}"\` and removing any \`[db] orioledb_version\` in supabase/config.toml, or ${destroy}`,
  );
});

it("offers each edit that applies when both the major and the line differ", () => {
  expect(messageFor(STOCK_15, ORIOLEDB_17)).toContain(
    `keep this data by pinning \`[local.services.database] version = "${STOCK_15}"\`, setting \`[db] major_version = 15\`, and removing any \`[db] orioledb_version\` in supabase/config.toml`,
  );
  expect(messageFor(ORIOLEDB_17, STOCK_15)).toContain(
    `keep this data by pinning \`[local.services.database] version = "${ORIOLEDB_17}"\` and setting \`[db] major_version = 17\` in supabase/config.toml`,
  );
});

it("offers only the recreate for data with no recorded identity", () => {
  expect(messageFor(undefined, STOCK_17_NEWER)).toBe(
    `PostgreSQL data has no recorded identity, but stock PostgreSQL build ${STOCK_17_NEWER} was requested; ${destroy}`,
  );
});

const marker = (runtime: DatabaseReadyMarker["runtime"]): DatabaseReadyMarker => ({
  runtime,
  profile: "supabase",
});

it.each([
  {
    found: "a marker of the same runtime",
    runtime: "native",
    observed: { marker: marker("native"), pgVersion: false },
    expected: "Initialized",
  },
  {
    found: "a marker beside PG_VERSION",
    runtime: "docker",
    observed: { marker: marker("docker"), pgVersion: true },
    expected: "Initialized",
  },
  {
    found: "a bare PG_VERSION",
    runtime: "native",
    observed: { marker: undefined, pgVersion: true },
    expected: "Initialized",
  },
  {
    found: "a bare PG_VERSION",
    runtime: "docker",
    observed: { marker: undefined, pgVersion: true },
    expected: "Fresh",
  },
  {
    found: "a bare PG_VERSION",
    runtime: "podman",
    observed: { marker: undefined, pgVersion: true },
    expected: "Fresh",
  },
  {
    found: "nothing",
    runtime: "native",
    observed: { marker: undefined, pgVersion: false },
    expected: "Fresh",
  },
  {
    found: "a marker of another runtime",
    runtime: "native",
    observed: { marker: marker("docker"), pgVersion: true },
    expected: "RuntimeMismatch",
  },
] as const)(
  "treats $found at the $runtime runtime as $expected",
  ({ runtime, observed, expected }) => {
    expect(databaseDataState(runtime, observed)._tag).toBe(expected);
  },
);
