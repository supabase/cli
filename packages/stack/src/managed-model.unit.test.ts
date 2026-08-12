import { describe, expect, it } from "vitest";
import * as model from "./managed/model.ts";
import { MANAGED_ERROR_CODES, ManagedStackError } from "./managed/model.ts";

interface ManagedErrorCase {
  readonly exportName: string;
  readonly error: Error;
  readonly code: unknown;
}

/**
 * Every exported strict subclass of {@link ManagedStackError}, discovered by
 * reflection rather than by hand: a subclass added without a registered code
 * must fail here instead of silently classifying as `unknown` downstream.
 * `prototype instanceof ManagedStackError` is false for the root itself, which
 * is exactly the set we want. Each class is probed with placeholder
 * constructor arguments because `code` is a field initializer rather than a
 * parameter: only the message interpolation reads them.
 */
const CONSTRUCTOR_PROBE = [{}, {}, {}];

const managedErrorCases: ReadonlyArray<ManagedErrorCase> = Object.entries(model).flatMap(
  ([exportName, value]) => {
    if (typeof value !== "function") return [];
    const prototype: unknown = value.prototype;
    if (typeof prototype !== "object" || prototype === null) return [];
    if (!(prototype instanceof ManagedStackError)) return [];
    const error: unknown = Reflect.construct(value, CONSTRUCTOR_PROBE);
    if (!(error instanceof Error)) return [];
    return [{ exportName, error, code: Reflect.get(error, "code") }];
  },
);

/**
 * Consumers cannot discriminate managed failures by class: they are plain
 * `Error` subclasses with no tag, and identifier minification renames the
 * constructors. The CLI's telemetry classifier therefore dispatches on `code`
 * (`apps/cli/src/shared/telemetry/error-actionability.ts`), so these literals
 * are a published contract rather than an implementation detail.
 */
describe("managed error contract", () => {
  it("keeps MANAGED_ERROR_CODES exhaustive against the exported subclasses", () => {
    expect(managedErrorCases.length).toBe(MANAGED_ERROR_CODES.length);
    expect(managedErrorCases.map(({ code }) => code).sort()).toEqual(
      [...MANAGED_ERROR_CODES].sort(),
    );
  });

  it.each(managedErrorCases)("exposes a stable code and class name on $exportName", (testCase) => {
    expect(testCase.error).toBeInstanceOf(ManagedStackError);
    expect(typeof testCase.code).toBe("string");
    expect(MANAGED_ERROR_CODES).toContain(testCase.code);
    expect(testCase.error.name).toBe(testCase.exportName);
    expect(testCase.error).not.toHaveProperty("_tag");
  });

  it.each([...MANAGED_ERROR_CODES])("declares %s on exactly one subclass", (code) => {
    expect(managedErrorCases.filter((testCase) => testCase.code === code)).toHaveLength(1);
  });
});
