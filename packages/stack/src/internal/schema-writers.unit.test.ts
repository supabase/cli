import { expect, it } from "@effect/vitest";
import {
  boundDatabaseId,
  compareUpstreamVersions,
  schemaWriterDowngrade,
} from "./schema-writers.ts";

it("orders each catalog version format by its leading dotted number", () => {
  const ascending = [
    ["v2.196.0", "v2.197.0"],
    ["v2.9.0", "v2.10.0"],
    ["2026.10.05-sha-aaaaaaa", "2026.10.12-sha-bbbbbbb"],
    ["17.6.1.054", "17.11.0.004"],
    ["0.58.0", "v0.100.0"],
    ["v1.30", "v1.30.1"],
    ["unversioned", "v0.0.1"],
  ] as const;
  for (const [older, newer] of ascending) {
    expect(compareUpstreamVersions(older, newer), `${older} < ${newer}`).toBe(-1);
    expect(compareUpstreamVersions(newer, older), `${newer} > ${older}`).toBe(1);
  }
});

it("treats versions that differ only by suffix or a v prefix as the same", () => {
  expect(compareUpstreamVersions("2026.10.12-sha-aaaaaaa", "2026.10.12-sha-bbbbbbb")).toBe(0);
  expect(compareUpstreamVersions("v2.197.0", "2.197.0")).toBe(0);
  expect(compareUpstreamVersions("v1.30", "v1.30.0")).toBe(0);
  expect(compareUpstreamVersions("unversioned", "other")).toBe(0);
});

it("offers to keep the data by pinning the recorded version before recreating the stack", () => {
  expect(schemaWriterDowngrade("stack-a", { auth: "v2.197.0" }, "auth", "v2.196.1")?.message).toBe(
    'auth v2.196.1 is older than v2.197.0, which already migrated this database; downgrading does not restore the old schema, so keep this data by pinning `[local.services.auth] version = "v2.197.0"` in supabase/config.toml, or run `supabase stack destroy --stack-id stack-a` to recreate the stack — this permanently deletes its local database data',
  );
});

const dependencies = [
  { from: "db", to: "auth", bindings: [{ output: "authDatabaseUrl", input: "databaseUrl" }] },
  { from: "db", to: "studio", bindings: [{ output: "databaseUrl", input: "databaseUrl" }] },
  { from: "mail", to: "auth", bindings: [{ output: "smtpUrl", input: "smtpUrl" }] },
  { from: "db", to: "functions" },
];
const services: Record<string, string> = {
  db: "database",
  mail: "mail",
  auth: "auth",
  studio: "studio",
  functions: "functions",
};
const serviceOf = (id: string) => services[id];

it("resolves the database an instance takes its databaseUrl from", () => {
  expect(boundDatabaseId(dependencies, serviceOf, "auth")).toBe("db");
  expect(boundDatabaseId(dependencies, serviceOf, "studio")).toBe("db");
});

it("leaves an instance unbound when no database feeds its databaseUrl", () => {
  expect(boundDatabaseId(dependencies, serviceOf, "functions")).toBeUndefined();
  expect(boundDatabaseId(dependencies, serviceOf, "storage")).toBeUndefined();
  expect(boundDatabaseId([], serviceOf, "auth")).toBeUndefined();
});
