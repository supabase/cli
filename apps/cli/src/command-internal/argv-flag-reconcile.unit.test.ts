import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { BunServices } from "@effect/platform-bun";
import { describe, expect, it } from "@effect/vitest";
import { Effect, Layer, Option, Result } from "effect";

import { CliArgs } from "../shared/cli/cli-args.service.ts";
import { ProfileFlag } from "./global-flags.ts";
import { mockRuntimeInfo } from "../../tests/helpers/mocks.ts";
import {
  argvBoolValue,
  argvEnumValue,
  argvProfileValue,
  argvWorkdirValue,
  resolveArgvProfile,
} from "./argv-flag-reconcile.ts";

// Sample enum values for the generic enum-reconciliation helper under test.
const NAME_ID_FORMATS = [
  "urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress",
  "urn:oasis:names:tc:SAML:1.1:nameid-format:unspecified",
  "urn:oasis:names:tc:SAML:2.0:nameid-format:persistent",
  "urn:oasis:names:tc:SAML:2.0:nameid-format:transient",
] as const;

const occ = (entries: ReadonlyArray<readonly [string, ReadonlyArray<string>]>) =>
  new Map(entries.map(([name, values]) => [name, [...values]]));

describe("argvBoolValue", () => {
  it("is false when the flag never occurs", () => {
    expect(argvBoolValue(occ([]), "skip-url-validation")).toEqual(Result.succeed(false));
  });

  it('treats a bare occurrence (recorded as "true") as true', () => {
    expect(argvBoolValue(occ([["skip-url-validation", ["true"]]]), "skip-url-validation")).toEqual(
      Result.succeed(true),
    );
  });

  it("resolves repeats last-wins, not first-wins", () => {
    // --skip-url-validation=false --skip-url-validation
    expect(
      argvBoolValue(occ([["skip-url-validation", ["false", "true"]]]), "skip-url-validation"),
    ).toEqual(Result.succeed(true));
    // --skip-url-validation --skip-url-validation=false
    expect(
      argvBoolValue(occ([["skip-url-validation", ["true", "false"]]]), "skip-url-validation"),
    ).toEqual(Result.succeed(false));
  });

  it("fails on an inline-empty occurrence", () => {
    // --skip-url-validation=false --skip-url-validation=
    expect(
      argvBoolValue(occ([["skip-url-validation", ["false", ""]]]), "skip-url-validation"),
    ).toEqual(
      Result.fail(`invalid argument "" for "--skip-url-validation" flag: expected a boolean`),
    );
  });

  it("accepts exactly the boolean literal set", () => {
    for (const raw of ["1", "t", "T", "TRUE", "true", "True"]) {
      expect(argvBoolValue(occ([["f", [raw]]]), "f")).toEqual(Result.succeed(true));
    }
    for (const raw of ["0", "f", "F", "FALSE", "false", "False"]) {
      expect(argvBoolValue(occ([["f", [raw]]]), "f")).toEqual(Result.succeed(false));
    }
  });

  it("fails with the invalid-argument message on the first bad occurrence", () => {
    expect(argvBoolValue(occ([["skip-url-validation", ["yes"]]]), "skip-url-validation")).toEqual(
      Result.fail(`invalid argument "yes" for "--skip-url-validation" flag: expected a boolean`),
    );
    expect(
      argvBoolValue(occ([["skip-url-validation", ["true", "no"]]]), "skip-url-validation"),
    ).toEqual(
      Result.fail(`invalid argument "no" for "--skip-url-validation" flag: expected a boolean`),
    );
  });
});

describe("argvEnumValue", () => {
  it("is none when the flag never occurs", () => {
    expect(argvEnumValue(occ([]), "name-id-format", NAME_ID_FORMATS)).toEqual(
      Result.succeed(Option.none()),
    );
  });

  it("resolves repeats last-wins", () => {
    const persistent = "urn:oasis:names:tc:SAML:2.0:nameid-format:persistent";
    const transient = "urn:oasis:names:tc:SAML:2.0:nameid-format:transient";
    expect(
      argvEnumValue(
        occ([["name-id-format", [transient, persistent]]]),
        "name-id-format",
        NAME_ID_FORMATS,
      ),
    ).toEqual(Result.succeed(Option.some(persistent)));
  });

  it("fails with the enum message when any occurrence is invalid", () => {
    const persistent = "urn:oasis:names:tc:SAML:2.0:nameid-format:persistent";
    expect(
      argvEnumValue(
        occ([["name-id-format", [persistent, "bogus"]]]),
        "name-id-format",
        NAME_ID_FORMATS,
      ),
    ).toEqual(
      Result.fail(
        `invalid argument "bogus" for "--name-id-format" flag: must be one of [ ${NAME_ID_FORMATS.join(" | ")} ]`,
      ),
    );
  });

  it("names the flag with its shorthand when a label is given", () => {
    expect(argvEnumValue(occ([["type", ["bogus"]]]), "type", ["saml"], "-t, --type")).toEqual(
      Result.fail(`invalid argument "bogus" for "-t, --type" flag: must be one of [ saml ]`),
    );
  });
});

describe("argvWorkdirValue", () => {
  const scan = (
    entries: ReadonlyArray<readonly [string, ReadonlyArray<string>]>,
    consumed: ReadonlyArray<string> = [],
    prePath: ReadonlyArray<readonly [string, ReadonlyArray<string>]> = [],
  ) => ({
    occurrences: occ(entries),
    consumedFlagNames: new Set(consumed),
    prePathOccurrences: occ(prePath),
  });

  it("resolves pre-path repeats last-wins (the parser is first-wins)", () => {
    // --workdir /existing --workdir /missing sso add …
    expect(
      argvWorkdirValue(
        scan([], [], [["workdir", ["/existing", "/missing"]]]),
        Option.some("/existing"),
        undefined,
      ),
    ).toEqual(Option.some("/missing"));
  });

  it("keeps a pre-path occurrence when the only post-path workdir token was consumed", () => {
    expect(
      argvWorkdirValue(scan([], ["workdir"], [["workdir", ["/pre"]]]), Option.some("/pre"), "/env"),
    ).toEqual(Option.some("/pre"));
  });

  it("post-path occurrences still win over pre-path ones (argv-order last-wins)", () => {
    expect(
      argvWorkdirValue(
        scan([["workdir", ["/post"]]], [], [["workdir", ["/pre"]]]),
        Option.some("/pre"),
        undefined,
      ),
    ).toEqual(Option.some("/post"));
  });

  it("resolves nothing when no flag, parsed value, or env var is present", () => {
    expect(argvWorkdirValue(scan([]), Option.none(), undefined)).toEqual(Option.none());
  });

  it("prefers the scan's occurrence over the parsed flag and the env var", () => {
    // --workdir --metadata-file …
    expect(
      argvWorkdirValue(scan([["workdir", ["--metadata-file"]]]), Option.none(), "/env"),
    ).toEqual(Option.some("--metadata-file"));
  });

  it("resolves repeats last-wins", () => {
    expect(
      argvWorkdirValue(scan([["workdir", ["/a", "/b"]]]), Option.some("/a"), undefined),
    ).toEqual(Option.some("/b"));
  });

  it("falls back to the parsed flag when the anchored scan saw no occurrence (pre-path --workdir)", () => {
    expect(argvWorkdirValue(scan([]), Option.some("/pre-path"), "/env")).toEqual(
      Option.some("/pre-path"),
    );
  });

  it("ignores the parsed flag when the --workdir token was consumed by another flag, falling to the env var", () => {
    // --domains --workdir /x
    expect(argvWorkdirValue(scan([], ["workdir"]), Option.some("/x"), "/env")).toEqual(
      Option.some("/env"),
    );
    expect(argvWorkdirValue(scan([], ["workdir"]), Option.some("/x"), undefined)).toEqual(
      Option.none(),
    );
  });

  it("uses the env var when neither the scan nor the parser saw the flag", () => {
    expect(argvWorkdirValue(scan([]), Option.none(), "/env")).toEqual(Option.some("/env"));
  });

  it("treats a changed-but-empty flag as the walk-up default, shadowing the env var", () => {
    // --workdir=
    expect(argvWorkdirValue(scan([["workdir", [""]]]), Option.none(), "/env")).toEqual(
      Option.none(),
    );
    expect(argvWorkdirValue(scan([]), Option.some(""), "/env")).toEqual(Option.none());
  });

  it("treats an empty env var as unset", () => {
    expect(argvWorkdirValue(scan([]), Option.none(), "")).toEqual(Option.none());
  });
});

describe("argvProfileValue", () => {
  const scan = (
    entries: ReadonlyArray<readonly [string, ReadonlyArray<string>]>,
    consumed: ReadonlyArray<string> = [],
    prePath: ReadonlyArray<readonly [string, ReadonlyArray<string>]> = [],
  ) => ({
    occurrences: occ(entries),
    consumedFlagNames: new Set(consumed),
    prePathOccurrences: occ(prePath),
  });

  it("keeps a pre-path occurrence when the only post-path profile token was consumed", () => {
    // --profile A sso add --type saml --domains --profile
    expect(
      argvProfileValue(
        scan([], ["profile"], [["profile", ["a.yml"]]]),
        Option.some("a.yml"),
        "env.yml",
      ),
    ).toEqual(Option.some("a.yml"));
  });

  it("resolves pre-path repeats last-wins (the parser is first-wins)", () => {
    expect(
      argvProfileValue(
        scan([], [], [["profile", ["a.yml", "b.yml"]]]),
        Option.some("a.yml"),
        undefined,
      ),
    ).toEqual(Option.some("b.yml"));
  });

  it("post-path occurrences still win over pre-path ones (argv-order last-wins)", () => {
    expect(
      argvProfileValue(
        scan([["profile", ["post.yml"]]], [], [["profile", ["pre.yml"]]]),
        Option.some("pre.yml"),
        undefined,
      ),
    ).toEqual(Option.some("post.yml"));
  });

  it("resolves nothing when no flag, parsed value, or env var is present (falls to the file/default)", () => {
    expect(argvProfileValue(scan([]), Option.none(), undefined)).toEqual(Option.none());
  });

  it("prefers the scan's occurrence over the parsed flag and the env var", () => {
    // --profile --metadata-url …
    expect(
      argvProfileValue(scan([["profile", ["--metadata-url"]]]), Option.none(), "env.yml"),
    ).toEqual(Option.some("--metadata-url"));
  });

  it("resolves repeats last-wins (the parser is first-wins)", () => {
    expect(
      argvProfileValue(scan([["profile", ["a.yml", "b.yml"]]]), Option.some("a.yml"), undefined),
    ).toEqual(Option.some("b.yml"));
  });

  it("keeps an explicit scanned `supabase` — it counts as set, shadowing the env var", () => {
    expect(argvProfileValue(scan([["profile", ["supabase"]]]), Option.none(), "env.yml")).toEqual(
      Option.some("supabase"),
    );
  });

  it("keeps a changed-but-empty occurrence — profile loading fails on it, never falling to the env", () => {
    expect(argvProfileValue(scan([["profile", [""]]]), Option.none(), "env.yml")).toEqual(
      Option.some(""),
    );
  });

  it("falls back to the parsed flag when the anchored scan saw no occurrence (pre-path --profile)", () => {
    expect(argvProfileValue(scan([]), Option.some("pre.yml"), "env.yml")).toEqual(
      Option.some("pre.yml"),
    );
  });

  it("ignores the parsed flag when the --profile token was consumed by another flag, falling to the env var", () => {
    // --domains --profile alternate.yml
    expect(
      argvProfileValue(scan([], ["profile"]), Option.some("alternate.yml"), "env.yml"),
    ).toEqual(Option.some("env.yml"));
    expect(
      argvProfileValue(scan([], ["profile"]), Option.some("alternate.yml"), undefined),
    ).toEqual(Option.none());
  });

  it("uses the env var when neither the scan nor the parser saw the flag", () => {
    expect(argvProfileValue(scan([]), Option.none(), "env.yml")).toEqual(Option.some("env.yml"));
  });

  it("treats an empty env var as unset", () => {
    expect(argvProfileValue(scan([]), Option.none(), "")).toEqual(Option.none());
  });
});

describe("resolveArgvProfile", () => {
  const withEnvProfile = <A, E, R>(value: string, effect: Effect.Effect<A, E, R>) => {
    const prev = process.env["SUPABASE_PROFILE"];
    process.env["SUPABASE_PROFILE"] = value;
    return effect.pipe(
      Effect.ensuring(
        Effect.sync(() => {
          if (prev === undefined) delete process.env["SUPABASE_PROFILE"];
          else process.env["SUPABASE_PROFILE"] = prev;
        }),
      ),
    );
  };

  const services = (args: ReadonlyArray<string>, homeDir: string) =>
    Layer.mergeAll(
      BunServices.layer,
      Layer.succeed(ProfileFlag, "supabase"),
      Layer.succeed(CliArgs, { args }),
      mockRuntimeInfo({ homeDir }),
    );

  // --domains --profile supabase: the config layer's raw scan shadows the env with the
  // swallowed --profile token; the reconcile must see the mismatch and re-load on the env
  // profile instead of returning none.
  it.effect(
    "re-loads the env profile when the layer's scan wrongly shadowed a consumed token",
    () => {
      const dir = mkdtempSync(join(tmpdir(), "supabase-argv-flag-reconcile-"));
      const profilePath = join(dir, "env.yml");
      writeFileSync(
        profilePath,
        [
          "name: harness",
          "api_url: http://127.0.0.1:45555",
          "dashboard_url: http://127.0.0.1:45555",
          "project_host: localhost",
        ].join("\n"),
      );
      return withEnvProfile(
        profilePath,
        Effect.gen(function* () {
          const resolved = yield* resolveArgvProfile({
            occurrences: new Map(),
            consumedFlagNames: new Set(["profile"]),
            prePathOccurrences: new Map(),
          });
          expect(Option.isSome(resolved)).toBe(true);
          if (Option.isSome(resolved)) {
            expect(resolved.value.name).toBe("harness");
            expect(resolved.value.apiUrl).toBe("http://127.0.0.1:45555");
          }
        }).pipe(
          Effect.provide(
            services(["sso", "add", "--type", "saml", "--domains", "--profile", "supabase"], dir),
          ),
          Effect.ensuring(Effect.sync(() => rmSync(dir, { recursive: true, force: true }))),
        ),
      );
    },
  );

  it.effect("returns none when the scan and the layer agree on an explicit supabase", () => {
    const dir = mkdtempSync(join(tmpdir(), "supabase-argv-flag-reconcile-"));
    return withEnvProfile(
      "rogue-profile",
      Effect.gen(function* () {
        const resolved = yield* resolveArgvProfile({
          occurrences: new Map([["profile", ["supabase"]]]),
          consumedFlagNames: new Set<string>(),
          prePathOccurrences: new Map(),
        });
        expect(Option.isNone(resolved)).toBe(true);
      }).pipe(
        Effect.provide(services(["sso", "add", "--profile", "supabase"], dir)),
        Effect.ensuring(Effect.sync(() => rmSync(dir, { recursive: true, force: true }))),
      ),
    );
  });
});
