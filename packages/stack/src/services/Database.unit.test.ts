import { expect, it } from "@effect/vitest";
import { nativePostgresRootError } from "./Database.ts";

it("refuses native PostgreSQL for uid 0 and allows every other runtime", () => {
  expect(nativePostgresRootError("native", 0)).toBe("PostgreSQL cannot be run as root");
  expect(nativePostgresRootError("native", 501)).toBeUndefined();
  expect(nativePostgresRootError("native", undefined)).toBeUndefined();
  expect(nativePostgresRootError("docker", 0)).toBeUndefined();
  expect(nativePostgresRootError("podman", 0)).toBeUndefined();
});
