import { describe, expect, it } from "@effect/vitest";
import { Option, Result } from "effect";

import { legacySsoPflagBoolValue, legacySsoPflagEnumValue } from "./sso.pflag-reconcile.ts";
import { LEGACY_SSO_NAME_ID_FORMATS } from "./sso.saml.ts";

const occ = (entries: ReadonlyArray<readonly [string, ReadonlyArray<string>]>) =>
  new Map(entries.map(([name, values]) => [name, [...values]]));

describe("legacySsoPflagBoolValue", () => {
  it("is false when the flag never occurs (Go default)", () => {
    expect(legacySsoPflagBoolValue(occ([]), "skip-url-validation")).toEqual(Result.succeed(false));
  });

  it("treats a bare occurrence as pflag's NoOptDefVal true", () => {
    expect(
      legacySsoPflagBoolValue(occ([["skip-url-validation", [""]]]), "skip-url-validation"),
    ).toEqual(Result.succeed(true));
  });

  it("resolves repeats last-wins, not first-wins (pflag Sets every occurrence)", () => {
    // `--skip-url-validation=false --skip-url-validation` — Go ends up true.
    expect(
      legacySsoPflagBoolValue(occ([["skip-url-validation", ["false", ""]]]), "skip-url-validation"),
    ).toEqual(Result.succeed(true));
    // `--skip-url-validation --skip-url-validation=false` — Go ends up false.
    expect(
      legacySsoPflagBoolValue(occ([["skip-url-validation", ["", "false"]]]), "skip-url-validation"),
    ).toEqual(Result.succeed(false));
  });

  it("accepts exactly Go's strconv.ParseBool literal set", () => {
    for (const raw of ["1", "t", "T", "TRUE", "true", "True"]) {
      expect(legacySsoPflagBoolValue(occ([["f", [raw]]]), "f")).toEqual(Result.succeed(true));
    }
    for (const raw of ["0", "f", "F", "FALSE", "false", "False"]) {
      expect(legacySsoPflagBoolValue(occ([["f", [raw]]]), "f")).toEqual(Result.succeed(false));
    }
  });

  it("fails with pflag's byte-exact invalid-argument message on the first bad occurrence", () => {
    // The Effect parser accepts `yes`/`no`; Go's strconv.ParseBool does not.
    expect(
      legacySsoPflagBoolValue(occ([["skip-url-validation", ["yes"]]]), "skip-url-validation"),
    ).toEqual(
      Result.fail(
        `invalid argument "yes" for "--skip-url-validation" flag: strconv.ParseBool: parsing "yes": invalid syntax`,
      ),
    );
    // A later invalid occurrence still fails — pflag Sets each one in order.
    expect(
      legacySsoPflagBoolValue(
        occ([["skip-url-validation", ["true", "no"]]]),
        "skip-url-validation",
      ),
    ).toEqual(
      Result.fail(
        `invalid argument "no" for "--skip-url-validation" flag: strconv.ParseBool: parsing "no": invalid syntax`,
      ),
    );
  });
});

describe("legacySsoPflagEnumValue", () => {
  it("is none when the flag never occurs", () => {
    expect(legacySsoPflagEnumValue(occ([]), "name-id-format", LEGACY_SSO_NAME_ID_FORMATS)).toEqual(
      Result.succeed(Option.none()),
    );
  });

  it("resolves repeats last-wins, matching pflag", () => {
    const persistent = "urn:oasis:names:tc:SAML:2.0:nameid-format:persistent";
    const transient = "urn:oasis:names:tc:SAML:2.0:nameid-format:transient";
    expect(
      legacySsoPflagEnumValue(
        occ([["name-id-format", [transient, persistent]]]),
        "name-id-format",
        LEGACY_SSO_NAME_ID_FORMATS,
      ),
    ).toEqual(Result.succeed(Option.some(persistent)));
  });

  it("fails with the Go enum Set message when any occurrence is invalid", () => {
    const persistent = "urn:oasis:names:tc:SAML:2.0:nameid-format:persistent";
    expect(
      legacySsoPflagEnumValue(
        occ([["name-id-format", [persistent, "bogus"]]]),
        "name-id-format",
        LEGACY_SSO_NAME_ID_FORMATS,
      ),
    ).toEqual(
      Result.fail(
        `invalid argument "bogus" for "--name-id-format" flag: must be one of [ ${LEGACY_SSO_NAME_ID_FORMATS.join(" | ")} ]`,
      ),
    );
  });

  it("names the flag with its shorthand when a label is given (pflag errors.go:39-41)", () => {
    expect(
      legacySsoPflagEnumValue(occ([["type", ["bogus"]]]), "type", ["saml"], "-t, --type"),
    ).toEqual(
      Result.fail(`invalid argument "bogus" for "-t, --type" flag: must be one of [ saml ]`),
    );
  });
});
