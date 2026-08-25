import { describe, expect, it } from "vitest";
import { Predicate } from "effect";
import {
  CyclicDependencyError,
  MissingDependencyError,
  ServiceNotFoundError,
  SpawnError,
} from "./errors.ts";

describe("errors", () => {
  it("CyclicDependencyError has correct tag and data", () => {
    const err = new CyclicDependencyError({ cycle: "a -> b -> a" });
    expect(Predicate.isTagged(err, "CyclicDependencyError")).toBe(true);
    expect(err.cycle).toBe("a -> b -> a");
  });

  it("MissingDependencyError has correct tag and data", () => {
    const err = new MissingDependencyError({ service: "app", dependency: "db" });
    expect(Predicate.isTagged(err, "MissingDependencyError")).toBe(true);
    expect(err.service).toBe("app");
    expect(err.dependency).toBe("db");
  });

  it("ServiceNotFoundError has correct tag and data", () => {
    const err = new ServiceNotFoundError({ name: "unknown" });
    expect(Predicate.isTagged(err, "ServiceNotFoundError")).toBe(true);
    expect(err.name).toBe("unknown");
  });

  it("SpawnError has correct tag and data", () => {
    const cause = new Error("ENOENT");
    const err = new SpawnError({ service: "postgres", cause });
    expect(Predicate.isTagged(err, "SpawnError")).toBe(true);
    expect(err.service).toBe("postgres");
    expect(err.cause).toBe(cause);
  });
});
