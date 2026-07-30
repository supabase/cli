import { describe, expect, it } from "@effect/vitest";
import { Option, Result } from "effect";

import {
  legacySsoPflagBoolValue,
  legacySsoPflagEnumValue,
  legacySsoPflagProfileValue,
  legacySsoPflagWorkdirValue,
} from "./sso.pflag-reconcile.ts";
import { LEGACY_SSO_NAME_ID_FORMATS } from "./sso.saml.ts";

const occ = (entries: ReadonlyArray<readonly [string, ReadonlyArray<string>]>) =>
  new Map(entries.map(([name, values]) => [name, [...values]]));

describe("legacySsoPflagBoolValue", () => {
  it("is false when the flag never occurs (Go default)", () => {
    expect(legacySsoPflagBoolValue(occ([]), "skip-url-validation")).toEqual(Result.succeed(false));
  });

  it('treats a bare occurrence (recorded as pflag\'s NoOptDefVal "true") as true', () => {
    expect(
      legacySsoPflagBoolValue(occ([["skip-url-validation", ["true"]]]), "skip-url-validation"),
    ).toEqual(Result.succeed(true));
  });

  it("resolves repeats last-wins, not first-wins (pflag Sets every occurrence)", () => {
    // `--skip-url-validation=false --skip-url-validation` — Go ends up true.
    expect(
      legacySsoPflagBoolValue(
        occ([["skip-url-validation", ["false", "true"]]]),
        "skip-url-validation",
      ),
    ).toEqual(Result.succeed(true));
    // `--skip-url-validation --skip-url-validation=false` — Go ends up false.
    expect(
      legacySsoPflagBoolValue(
        occ([["skip-url-validation", ["true", "false"]]]),
        "skip-url-validation",
      ),
    ).toEqual(Result.succeed(false));
  });

  it("fails on an inline-empty occurrence exactly like Go's ParseBool", () => {
    // `--skip-url-validation=false --skip-url-validation=` — the Effect
    // parser resolves repeats first-wins and never validates the second
    // occurrence, but pflag hands `""` to strconv.ParseBool and aborts
    // ParseFlags before any request (binary-verified, PR #5974 round 5).
    expect(
      legacySsoPflagBoolValue(occ([["skip-url-validation", ["false", ""]]]), "skip-url-validation"),
    ).toEqual(
      Result.fail(
        `invalid argument "" for "--skip-url-validation" flag: strconv.ParseBool: parsing "": invalid syntax`,
      ),
    );
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

describe("legacySsoPflagWorkdirValue", () => {
  const scan = (
    entries: ReadonlyArray<readonly [string, ReadonlyArray<string>]>,
    consumed: ReadonlyArray<string> = [],
  ) => ({ occurrences: occ(entries), consumedFlagNames: new Set(consumed) });

  it("resolves nothing when no flag, parsed value, or env var is present (Go walks up)", () => {
    expect(legacySsoPflagWorkdirValue(scan([]), Option.none(), undefined)).toEqual(Option.none());
  });

  it("prefers the scan's occurrence over the parsed flag and the env var", () => {
    // `--workdir --metadata-file …`: pflag binds the flag-shaped token; the
    // Effect parser refused it and left the flag unset (PR #5974 round 6).
    expect(
      legacySsoPflagWorkdirValue(scan([["workdir", ["--metadata-file"]]]), Option.none(), "/env"),
    ).toEqual(Option.some("--metadata-file"));
  });

  it("resolves repeats last-wins, matching pflag StringVar", () => {
    expect(
      legacySsoPflagWorkdirValue(scan([["workdir", ["/a", "/b"]]]), Option.some("/a"), undefined),
    ).toEqual(Option.some("/b"));
  });

  it("falls back to the parsed flag when the anchored scan saw no occurrence (pre-path --workdir)", () => {
    expect(legacySsoPflagWorkdirValue(scan([]), Option.some("/pre-path"), "/env")).toEqual(
      Option.some("/pre-path"),
    );
  });

  it("ignores the parsed flag when the --workdir token was consumed by another flag, falling to the env var", () => {
    // `--domains --workdir /x`: pflag hands `--workdir` to `--domains` and
    // never marks workdir changed, so viper falls to SUPABASE_WORKDIR
    // (binary-verified against apps/cli-go, PR #5974 round 6).
    expect(legacySsoPflagWorkdirValue(scan([], ["workdir"]), Option.some("/x"), "/env")).toEqual(
      Option.some("/env"),
    );
    expect(legacySsoPflagWorkdirValue(scan([], ["workdir"]), Option.some("/x"), undefined)).toEqual(
      Option.none(),
    );
  });

  it("uses the env var when neither the scan nor the parser saw the flag", () => {
    expect(legacySsoPflagWorkdirValue(scan([]), Option.none(), "/env")).toEqual(
      Option.some("/env"),
    );
  });

  it("treats a changed-but-empty flag as the walk-up default, shadowing the env var (viper precedence)", () => {
    // `--workdir=`: viper returns the changed flag's empty value and Go falls
    // through to the always-existing project root, never to SUPABASE_WORKDIR
    // (binary-verified: the command proceeds to POST).
    expect(legacySsoPflagWorkdirValue(scan([["workdir", [""]]]), Option.none(), "/env")).toEqual(
      Option.none(),
    );
    expect(legacySsoPflagWorkdirValue(scan([]), Option.some(""), "/env")).toEqual(Option.none());
  });

  it("treats an empty env var as unset", () => {
    expect(legacySsoPflagWorkdirValue(scan([]), Option.none(), "")).toEqual(Option.none());
  });
});

describe("legacySsoPflagProfileValue", () => {
  const scan = (
    entries: ReadonlyArray<readonly [string, ReadonlyArray<string>]>,
    consumed: ReadonlyArray<string> = [],
  ) => ({ occurrences: occ(entries), consumedFlagNames: new Set(consumed) });

  it("resolves nothing when no flag, parsed value, or env var is present (Go falls to the file/default)", () => {
    expect(legacySsoPflagProfileValue(scan([]), Option.none(), undefined)).toEqual(Option.none());
  });

  it("prefers the scan's occurrence over the parsed flag and the env var", () => {
    // `--profile --metadata-url …`: pflag binds the flag-shaped token; the
    // Effect parser refused it and left the flag at its default (PR #5974
    // round 7).
    expect(
      legacySsoPflagProfileValue(scan([["profile", ["--metadata-url"]]]), Option.none(), "env.yml"),
    ).toEqual(Option.some("--metadata-url"));
  });

  it("resolves repeats last-wins, matching pflag StringVar (the parser is first-wins)", () => {
    expect(
      legacySsoPflagProfileValue(
        scan([["profile", ["a.yml", "b.yml"]]]),
        Option.some("a.yml"),
        undefined,
      ),
    ).toEqual(Option.some("b.yml"));
  });

  it("keeps an explicit scanned `supabase` — pflag marks it changed, shadowing the env var", () => {
    // viper: a changed flag wins even at its default value; the config layer
    // cannot see this (its parsed flag can't distinguish default from
    // explicit), so the scan is authoritative post-command-path.
    expect(
      legacySsoPflagProfileValue(scan([["profile", ["supabase"]]]), Option.none(), "env.yml"),
    ).toEqual(Option.some("supabase"));
  });

  it("keeps a changed-but-empty occurrence — Go fails LoadProfile on it, never falling to the env", () => {
    expect(legacySsoPflagProfileValue(scan([["profile", [""]]]), Option.none(), "env.yml")).toEqual(
      Option.some(""),
    );
  });

  it("falls back to the parsed flag when the anchored scan saw no occurrence (pre-path --profile)", () => {
    expect(legacySsoPflagProfileValue(scan([]), Option.some("pre.yml"), "env.yml")).toEqual(
      Option.some("pre.yml"),
    );
  });

  it("ignores the parsed flag when the --profile token was consumed by another flag, falling to the env var", () => {
    // `--domains --profile alternate.yml`: pflag hands `--profile` to
    // `--domains` and never marks profile changed, so viper falls to
    // SUPABASE_PROFILE (binary-verified against apps/cli-go, PR #5974
    // round 7 — the demonstrated divergent input).
    expect(
      legacySsoPflagProfileValue(scan([], ["profile"]), Option.some("alternate.yml"), "env.yml"),
    ).toEqual(Option.some("env.yml"));
    expect(
      legacySsoPflagProfileValue(scan([], ["profile"]), Option.some("alternate.yml"), undefined),
    ).toEqual(Option.none());
  });

  it("uses the env var when neither the scan nor the parser saw the flag", () => {
    expect(legacySsoPflagProfileValue(scan([]), Option.none(), "env.yml")).toEqual(
      Option.some("env.yml"),
    );
  });

  it("treats an empty env var as unset", () => {
    expect(legacySsoPflagProfileValue(scan([]), Option.none(), "")).toEqual(Option.none());
  });
});
