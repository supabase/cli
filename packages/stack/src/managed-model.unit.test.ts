import { describe, expect, it } from "vitest";
import * as model from "./managed/model.ts";
import {
  MANAGED_ERROR_CODES,
  MANAGED_ERROR_TAG_BY_CODE,
  isManagedStackError,
} from "./managed/model.ts";

interface ManagedErrorCase {
  readonly exportName: string;
  readonly error: Error;
  readonly code: unknown;
  readonly tag: unknown;
}

/**
 * A single fields bag covering every field name declared across the managed
 * failures. Each class ignores the members it does not declare, so one probe
 * constructs them all: `code` is a field initializer, and only the message
 * getters read the fields. Values are supplied rather than left absent so a
 * getter that reaches into a structured field (the in-progress operation
 * record) stays evaluable; a class introducing a new field name constructs with
 * that field missing and fails loudly here rather than silently.
 */
const CONSTRUCTOR_PROBE = {
  message: "probe",
  found: 0,
  supported: 0,
  identityId: "probe",
  existingClaim: "probe",
  requestedClaim: "probe",
  stackName: "probe",
  ownerPid: 0,
  port: 0,
  key: "probe",
  stackId: "probe",
  operation: { kind: "start" },
  ownerStackId: "probe",
  path: "probe",
  cleanupErrors: [],
};

/**
 * Every error class exported from `./managed/model.ts`, discovered by
 * reflection rather than by hand: the module declares nothing but managed
 * failures, so an exported `Error` class that is missing from the code list or
 * the tag map must fail here instead of silently classifying as `unknown`
 * downstream. Discovery deliberately does not use {@link isManagedStackError} —
 * that guard reads the tag map, which is one of the things under test.
 */
const managedErrorCases: ReadonlyArray<ManagedErrorCase> = Object.entries(model).flatMap(
  ([exportName, value]) => {
    if (typeof value !== "function") return [];
    const prototype: unknown = value.prototype;
    if (typeof prototype !== "object" || prototype === null) return [];
    if (!(prototype instanceof Error)) return [];
    const error: unknown = Reflect.construct(value, [CONSTRUCTOR_PROBE]);
    if (!(error instanceof Error)) return [];
    return [
      {
        exportName,
        error,
        code: Reflect.get(error, "code"),
        tag: Reflect.get(error, "_tag"),
      },
    ];
  },
);

/**
 * Managed failures are `Data.TaggedError` classes: `_tag` is the Effect-native
 * discriminant, and `code` is the wire-level contract. Identifier minification
 * renames the constructors but touches neither, and the CLI's telemetry
 * classifier dispatches on the tag while keying its table by the code
 * (`apps/cli/src/shared/telemetry/error-actionability.ts`), so both literals
 * and the mapping between them are published contracts rather than
 * implementation details.
 */
describe("managed error contract", () => {
  it("keeps MANAGED_ERROR_CODES exhaustive against the exported classes", () => {
    expect(managedErrorCases.length).toBe(MANAGED_ERROR_CODES.length);
    expect(managedErrorCases.map(({ code }) => code).sort()).toEqual(
      [...MANAGED_ERROR_CODES].sort(),
    );
  });

  it.each(managedErrorCases)(
    "exposes a stable code, tag and class name on $exportName",
    (testCase) => {
      expect(isManagedStackError(testCase.error)).toBe(true);
      expect(typeof testCase.code).toBe("string");
      expect(MANAGED_ERROR_CODES).toContain(testCase.code);
      expect(testCase.tag).toBe(testCase.exportName);
      // `Data.TaggedError` installs the literal tag as a `name` data property
      // on the generated base prototype, so `error.name` keeps reporting the
      // class name — including in minified release builds, where
      // `constructor.name` is renamed.
      expect(testCase.error.name).toBe(testCase.exportName);
    },
  );

  it.each([...MANAGED_ERROR_CODES])("declares %s on exactly one class", (code) => {
    expect(managedErrorCases.filter((testCase) => testCase.code === code)).toHaveLength(1);
  });

  it("maps every code to the tag of the class declaring it", () => {
    expect(Object.keys(MANAGED_ERROR_TAG_BY_CODE).sort()).toEqual([...MANAGED_ERROR_CODES].sort());
    for (const { code, tag } of managedErrorCases) {
      expect(Reflect.get(MANAGED_ERROR_TAG_BY_CODE, String(code))).toBe(tag);
    }
  });

  it("recognizes managed failures without a shared base class", () => {
    expect(isManagedStackError(new model.ManagedStackNotFoundError({ stackId: "stack" }))).toBe(
      true,
    );
    expect(isManagedStackError(new Error("plain"))).toBe(false);
    // A bare structural lookalike is not a managed failure: the guard requires
    // a real Error so it cannot promote arbitrary payloads.
    expect(isManagedStackError({ _tag: "ManagedStackNotFoundError" })).toBe(false);
    expect(isManagedStackError(undefined)).toBe(false);
  });
});
