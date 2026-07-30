import { describe, expect, test } from "vitest";
import {
  cobraMutuallyExclusiveErrorMessage,
  hasExplicitLongFlag,
  PERSISTENT_VALUE_FLAG_NAMES,
  PERSISTENT_VALUE_FLAG_SHORTHANDS,
  pflagArgvScan,
} from "./cobra-flag-groups.ts";

const COMMAND_PATH = ["functions", "deploy"] as const;

describe("hasExplicitLongFlag", () => {
  test("finds a bare flag after the command path", () => {
    expect(hasExplicitLongFlag(["functions", "deploy", "--use-api"], COMMAND_PATH, "use-api")).toBe(
      true,
    );
  });

  test("finds a flag with an inline value", () => {
    expect(
      hasExplicitLongFlag(
        ["functions", "deploy", "--use-docker=false"],
        COMMAND_PATH,
        "use-docker",
      ),
    ).toBe(true);
  });

  test("returns false when the flag is absent", () => {
    expect(hasExplicitLongFlag(["functions", "deploy", "hello"], COMMAND_PATH, "use-api")).toBe(
      false,
    );
  });

  test("stops scanning at a -- terminator", () => {
    expect(
      hasExplicitLongFlag(["functions", "deploy", "--", "--use-api"], COMMAND_PATH, "use-api"),
    ).toBe(false);
  });

  test("ignores a flag that appears before the command path", () => {
    expect(hasExplicitLongFlag(["--use-api", "functions", "deploy"], COMMAND_PATH, "use-api")).toBe(
      false,
    );
  });

  test("falls back to a bare scan when the command path is not found", () => {
    expect(hasExplicitLongFlag(["--use-api"], COMMAND_PATH, "use-api")).toBe(true);
    expect(hasExplicitLongFlag(["--use-docker"], COMMAND_PATH, "use-api")).toBe(false);
  });
});

describe("pflagArgvScan", () => {
  const SSO_UPDATE_PATH = ["sso", "update"] as const;
  const SPEC = {
    valueFlagNames: new Set([
      "metadata-file",
      "metadata-url",
      "domains",
      "add-domains",
      ...PERSISTENT_VALUE_FLAG_NAMES,
    ]),
    valueFlagShorthands: PERSISTENT_VALUE_FLAG_SHORTHANDS,
  };

  test("records a bare flag's next token as its value", () => {
    const { occurrences } = pflagArgvScan(
      ["sso", "update", "id", "--metadata-file", "foo.xml"],
      SSO_UPDATE_PATH,
      SPEC,
    );
    expect(occurrences.get("metadata-file")).toEqual(["foo.xml"]);
  });

  test("records an inline (`=`) value, split on the first `=`", () => {
    const { occurrences } = pflagArgvScan(
      ["sso", "update", "id", "--domains=a.com", "--metadata-file=a=b"],
      SSO_UPDATE_PATH,
      SPEC,
    );
    expect(occurrences.get("domains")).toEqual(["a.com"]);
    expect(occurrences.get("metadata-file")).toEqual(["a=b"]);
  });

  test("an explicit empty `--flag=` still counts as changed", () => {
    const { occurrences } = pflagArgvScan(
      ["sso", "update", "id", "--metadata-file="],
      SSO_UPDATE_PATH,
      SPEC,
    );
    expect(occurrences.get("metadata-file")).toEqual([""]);
  });

  test("a consumed flag-shaped token becomes the value, not a sibling flag", () => {
    // pflag's `--flag arg` branch consumes the next token unconditionally
    // (`flag.go:1013-1031`), so `--metadata-file --metadata-url` gives
    // `metadata-file` the literal value `"--metadata-url"` and never parses
    // `--metadata-url` as its own flag.
    const scan = pflagArgvScan(
      ["sso", "update", "id", "--metadata-file", "--metadata-url"],
      SSO_UPDATE_PATH,
      SPEC,
    );
    expect(scan.occurrences.get("metadata-file")).toEqual(["--metadata-url"]);
    expect(scan.occurrences.has("metadata-url")).toBe(false);
    expect(scan.consumedFlagNames.has("metadata-url")).toBe(true);
  });

  test("a consumed flag-shaped token becomes the value, reversed order", () => {
    const scan = pflagArgvScan(
      ["sso", "update", "id", "--metadata-url", "--metadata-file"],
      SSO_UPDATE_PATH,
      SPEC,
    );
    expect(scan.occurrences.get("metadata-url")).toEqual(["--metadata-file"]);
    expect(scan.occurrences.has("metadata-file")).toBe(false);
    expect(scan.consumedFlagNames.has("metadata-file")).toBe(true);
  });

  test("an inline (`=`) value never consumes the next token", () => {
    // `--metadata-file=--metadata-url` is one token: metadata-file's value is
    // the literal string "--metadata-url", and no token is consumed after it.
    const scan = pflagArgvScan(
      ["sso", "update", "id", "--metadata-file=--metadata-url", "--domains", "a.com"],
      SSO_UPDATE_PATH,
      SPEC,
    );
    expect(scan.occurrences.get("metadata-file")).toEqual(["--metadata-url"]);
    expect(scan.occurrences.has("metadata-url")).toBe(false);
    expect(scan.occurrences.get("domains")).toEqual(["a.com"]);
    // The inline form consumed nothing — no flag token was swallowed.
    expect(scan.consumedFlagNames.size).toBe(0);
  });

  test("real, non-adjacent occurrences of both flags are both recorded", () => {
    const { occurrences } = pflagArgvScan(
      ["sso", "update", "id", "--metadata-file", "foo.xml", "--metadata-url", "url"],
      SSO_UPDATE_PATH,
      SPEC,
    );
    expect(occurrences.get("metadata-file")).toEqual(["foo.xml"]);
    expect(occurrences.get("metadata-url")).toEqual(["url"]);
  });

  test("repeated occurrences accumulate in argv order", () => {
    const { occurrences } = pflagArgvScan(
      ["sso", "update", "id", "--domains", "a.com", "--domains=b.com"],
      SSO_UPDATE_PATH,
      SPEC,
    );
    expect(occurrences.get("domains")).toEqual(["a.com", "b.com"]);
  });

  test("a bare boolean (non-value) flag records pflag's NoOptDefVal true without consuming", () => {
    const scan = pflagArgvScan(
      ["sso", "update", "id", "--skip-url-validation", "--metadata-url", "url"],
      SSO_UPDATE_PATH,
      SPEC,
    );
    expect(scan.occurrences.get("skip-url-validation")).toEqual(["true"]);
    expect(scan.occurrences.get("metadata-url")).toEqual(["url"]);
    expect(scan.positionals).toEqual(["id"]);
  });

  test("an inline-empty boolean (`--flag=`) records the empty string, distinct from bare", () => {
    // pflag `flag.go:1014-1019`: `--flag=` Sets `""` (which ParseBool later
    // rejects) while a bare `--flag` Sets NoOptDefVal `"true"` — the scan
    // must preserve that difference (PR #5974 review round 5).
    const scan = pflagArgvScan(
      ["sso", "update", "id", "--skip-url-validation=false", "--skip-url-validation="],
      SSO_UPDATE_PATH,
      SPEC,
    );
    expect(scan.occurrences.get("skip-url-validation")).toEqual(["false", ""]);
  });

  test("returns an empty map when no flags are present", () => {
    expect(pflagArgvScan(["sso", "update", "id"], SSO_UPDATE_PATH, SPEC).occurrences.size).toBe(0);
  });

  test("flags after a -- terminator are not recorded", () => {
    const { occurrences } = pflagArgvScan(
      ["sso", "update", "id", "--", "--domains"],
      SSO_UPDATE_PATH,
      SPEC,
    );
    expect(occurrences.has("domains")).toBe(false);
  });

  test("a -- consumed as a bare value flag's value does not terminate the scan", () => {
    const { occurrences } = pflagArgvScan(
      ["sso", "update", "id", "--metadata-file", "--", "--domains", "a.com"],
      SSO_UPDATE_PATH,
      SPEC,
    );
    expect(occurrences.get("metadata-file")).toEqual(["--"]);
    expect(occurrences.get("domains")).toEqual(["a.com"]);
  });

  describe("missing value detection (pflag ValueRequiredError parity)", () => {
    test("a bare value flag at the end of argv reports pflag's parse error", () => {
      // pflag fails `ParseFlags` before anything else runs (`errors.go:78`),
      // and the flag is never Set — so no occurrence is recorded either.
      const scan = pflagArgvScan(["sso", "update", "id", "--metadata-file"], SSO_UPDATE_PATH, SPEC);
      expect(scan.missingValueError).toBe("flag needs an argument: --metadata-file");
      expect(scan.occurrences.has("metadata-file")).toBe(false);
    });

    test("a bare value shorthand at the end of argv quotes the character", () => {
      // pflag `errors.go:75`: `flag needs an argument: %q in -%s`.
      const scan = pflagArgvScan(["sso", "update", "id", "-o"], SSO_UPDATE_PATH, SPEC);
      expect(scan.missingValueError).toBe("flag needs an argument: 'o' in -o");
      expect(scan.occurrences.has("output")).toBe(false);
    });

    test("an inline empty value (`--flag=`) is not a missing value", () => {
      const scan = pflagArgvScan(
        ["sso", "update", "id", "--metadata-file="],
        SSO_UPDATE_PATH,
        SPEC,
      );
      expect(scan.missingValueError).toBeUndefined();
      expect(scan.occurrences.get("metadata-file")).toEqual([""]);
    });

    test("a trailing boolean flag is not a missing value", () => {
      const scan = pflagArgvScan(
        ["sso", "update", "id", "--skip-url-validation"],
        SSO_UPDATE_PATH,
        SPEC,
      );
      expect(scan.missingValueError).toBeUndefined();
    });

    test("a value flag consuming a flag-shaped token is not a missing value", () => {
      const scan = pflagArgvScan(
        ["sso", "update", "id", "--domains", "--metadata-url"],
        SSO_UPDATE_PATH,
        SPEC,
      );
      expect(scan.missingValueError).toBeUndefined();
      expect(scan.occurrences.get("domains")).toEqual(["--metadata-url"]);
    });
  });

  test("ignores flags that appear before the command path", () => {
    const { occurrences } = pflagArgvScan(
      ["--domains", "a.com", "sso", "update", "id"],
      SSO_UPDATE_PATH,
      SPEC,
    );
    expect(occurrences.has("domains")).toBe(false);
  });

  test("falls back to a bare, unanchored scan when the command path is not found", () => {
    const scan = pflagArgvScan(["--domains", "a.com"], SSO_UPDATE_PATH, SPEC);
    expect(scan.anchored).toBe(false);
    expect(scan.occurrences.get("domains")).toEqual(["a.com"]);
    // An unscoped scan collects no positionals — it cannot tell command path
    // segments apart from operands.
    expect(scan.positionals).toEqual([]);
  });

  test("an unscoped scan does not treat -- as a terminator", () => {
    const { occurrences } = pflagArgvScan(["--", "--domains", "a.com"], SSO_UPDATE_PATH, SPEC);
    expect(occurrences.get("domains")).toEqual(["a.com"]);
  });

  describe("positional counting (cobra ValidateArgs parity)", () => {
    test("a plain invocation has exactly the operands as positionals", () => {
      const scan = pflagArgvScan(
        ["sso", "update", "id", "--domains", "a.com"],
        SSO_UPDATE_PATH,
        SPEC,
      );
      expect(scan.anchored).toBe(true);
      expect(scan.positionals).toEqual(["id"]);
    });

    test("a consumed flag token shifts its parser-value into the positionals", () => {
      // pflag hands `--metadata-url` to `--domains`; the URL the Effect
      // parser read as metadata-url's value is a positional to pflag, so
      // cobra's ExactArgs(1) sees 2 args (CLI-1982, PR #5974 review).
      const scan = pflagArgvScan(
        ["sso", "update", "--domains", "--metadata-url", "https://idp.example.com/m", "id"],
        SSO_UPDATE_PATH,
        SPEC,
      );
      expect(scan.occurrences.get("domains")).toEqual(["--metadata-url"]);
      expect(scan.occurrences.has("metadata-url")).toBe(false);
      expect(scan.positionals).toEqual(["https://idp.example.com/m", "id"]);
    });

    test("a persistent global value flag consumes its value token", () => {
      // `--workdir .` must not count `.` as a positional — pflag consumes it
      // (root persistent flags, `cmd/root.go:324-333`).
      const scan = pflagArgvScan(
        ["sso", "update", "--workdir", ".", "id", "--profile", "staging"],
        SSO_UPDATE_PATH,
        SPEC,
      );
      expect(scan.positionals).toEqual(["id"]);
    });

    test("a bare slice flag consumes a global flag token, orphaning its value", () => {
      // Binary-verified Go behaviour: `--domains --profile staging <id>`
      // arity-errors because `staging` becomes positional.
      const scan = pflagArgvScan(
        ["sso", "update", "--domains", "--profile", "staging", "id"],
        SSO_UPDATE_PATH,
        SPEC,
      );
      expect(scan.occurrences.get("domains")).toEqual(["--profile"]);
      expect(scan.consumedFlagNames.has("profile")).toBe(true);
      expect(scan.positionals).toEqual(["staging", "id"]);
    });

    test("tokens after a live -- terminator are all positionals", () => {
      const scan = pflagArgvScan(
        ["sso", "update", "id", "--", "--domains", "x"],
        SSO_UPDATE_PATH,
        SPEC,
      );
      expect(scan.positionals).toEqual(["id", "--domains", "x"]);
    });

    test("a lone - is a positional", () => {
      const scan = pflagArgvScan(["sso", "update", "-"], SSO_UPDATE_PATH, SPEC);
      expect(scan.positionals).toEqual(["-"]);
    });
  });

  describe("shorthand handling (pflag parseSingleShortArg parity)", () => {
    const ADD_PATH = ["sso", "add"] as const;
    const ADD_SPEC = {
      valueFlagNames: new Set(["type", "domains", "metadata-url", ...PERSISTENT_VALUE_FLAG_NAMES]),
      valueFlagShorthands: new Map([["t", "type"], ...PERSISTENT_VALUE_FLAG_SHORTHANDS]),
    };

    test("`-t saml` consumes the next token and records under the long name", () => {
      const scan = pflagArgvScan(["sso", "add", "-t", "saml"], ADD_PATH, ADD_SPEC);
      expect(scan.occurrences.get("type")).toEqual(["saml"]);
      expect(scan.positionals).toEqual([]);
    });

    test("`-o json` consumes the next token via the persistent shorthand map", () => {
      const scan = pflagArgvScan(["sso", "update", "-o", "json", "id"], SSO_UPDATE_PATH, SPEC);
      expect(scan.occurrences.get("output")).toEqual(["json"]);
      expect(scan.positionals).toEqual(["id"]);
    });

    test("`-o=json` and `-ojson` are self-contained", () => {
      const eq = pflagArgvScan(["sso", "update", "-o=json", "id"], SSO_UPDATE_PATH, SPEC);
      expect(eq.occurrences.get("output")).toEqual(["json"]);
      expect(eq.positionals).toEqual(["id"]);
      const glued = pflagArgvScan(["sso", "update", "-ojson", "id"], SSO_UPDATE_PATH, SPEC);
      expect(glued.occurrences.get("output")).toEqual(["json"]);
      expect(glued.positionals).toEqual(["id"]);
    });

    test("unknown/boolean shorthands consume nothing", () => {
      const scan = pflagArgvScan(["sso", "update", "-h", "id"], SSO_UPDATE_PATH, SPEC);
      expect(scan.occurrences.size).toBe(0);
      expect(scan.positionals).toEqual(["id"]);
    });
  });

  describe("anchoring across interspersed flags (cobra Find/stripFlags parity)", () => {
    test("a persistent value flag between group and leaf still anchors", () => {
      // cobra routes `sso --profile foo update <id>` to `sso update`
      // (`stripFlags` steps over the flag and its value while locating
      // subcommands) — binary-verified; the arity re-count must not be
      // skipped for such argv (PR #5974 review round 3).
      const scan = pflagArgvScan(
        ["sso", "--profile", "foo", "update", "id", "--domains", "a.com"],
        SSO_UPDATE_PATH,
        SPEC,
      );
      expect(scan.anchored).toBe(true);
      expect(scan.positionals).toEqual(["id"]);
      expect(scan.occurrences.get("domains")).toEqual(["a.com"]);
    });

    test("an interspersed value flag consuming a path-named token still anchors", () => {
      // `--profile update` hands the literal value "update" to --profile;
      // the NEXT "update" is the real leaf segment.
      const scan = pflagArgvScan(
        ["sso", "--profile", "update", "update", "id"],
        SSO_UPDATE_PATH,
        SPEC,
      );
      expect(scan.anchored).toBe(true);
      expect(scan.positionals).toEqual(["id"]);
    });

    test("interspersed boolean and self-contained shorthand flags still anchor", () => {
      const debug = pflagArgvScan(["sso", "--debug", "update", "id"], SSO_UPDATE_PATH, SPEC);
      expect(debug.anchored).toBe(true);
      expect(debug.positionals).toEqual(["id"]);
      const glued = pflagArgvScan(["sso", "-ojson", "update", "id"], SSO_UPDATE_PATH, SPEC);
      expect(glued.anchored).toBe(true);
      expect(glued.positionals).toEqual(["id"]);
    });

    test("an interspersed value shorthand consumes its value token", () => {
      const scan = pflagArgvScan(["sso", "-o", "json", "update", "id"], SSO_UPDATE_PATH, SPEC);
      expect(scan.anchored).toBe(true);
      expect(scan.positionals).toEqual(["id"]);
    });

    test("a leading value flag whose value collides with a path segment still anchors", () => {
      const scan = pflagArgvScan(
        ["--profile", "sso", "sso", "update", "id"],
        SSO_UPDATE_PATH,
        SPEC,
      );
      expect(scan.anchored).toBe(true);
      expect(scan.positionals).toEqual(["id"]);
    });

    test("a stray operand before the path fails the anchor open", () => {
      // `sso foo update` never routes to `sso update` (cobra treats `foo`
      // as an unknown subcommand), so the scan falls back to unscoped.
      const scan = pflagArgvScan(["sso", "foo", "update", "id"], SSO_UPDATE_PATH, SPEC);
      expect(scan.anchored).toBe(false);
      expect(scan.positionals).toEqual([]);
    });

    test("a -- before the path completes fails the anchor open", () => {
      const scan = pflagArgvScan(["sso", "--", "update", "id"], SSO_UPDATE_PATH, SPEC);
      expect(scan.anchored).toBe(false);
    });
  });

  describe("consumed flag tracking (cobra ValidateRequiredFlags parity)", () => {
    const ADD_PATH = ["sso", "add"] as const;
    const ADD_SPEC = {
      valueFlagNames: new Set(["type", "domains", ...PERSISTENT_VALUE_FLAG_NAMES]),
      valueFlagShorthands: new Map([["t", "type"], ...PERSISTENT_VALUE_FLAG_SHORTHANDS]),
    };

    test("a consumed bare `--type` is tracked and not marked changed", () => {
      const scan = pflagArgvScan(["sso", "add", "--domains", "--type", "saml"], ADD_PATH, ADD_SPEC);
      expect(scan.occurrences.has("type")).toBe(false);
      expect(scan.consumedFlagNames.has("type")).toBe(true);
    });

    test("a consumed `--type=saml` is tracked by its name before the `=`", () => {
      const scan = pflagArgvScan(["sso", "add", "--domains", "--type=saml"], ADD_PATH, ADD_SPEC);
      expect(scan.occurrences.has("type")).toBe(false);
      expect(scan.consumedFlagNames.has("type")).toBe(true);
    });

    test("a consumed `-t` shorthand is tracked under its long name", () => {
      // Binary-verified: `sso add --domains -t saml` fails Go's
      // required-flag check — pflag hands `-t` to `--domains` and `type`
      // stays unchanged, while `saml` becomes positional (PR #5974 review
      // round 3).
      const scan = pflagArgvScan(["sso", "add", "--domains", "-t", "saml"], ADD_PATH, ADD_SPEC);
      expect(scan.occurrences.has("type")).toBe(false);
      expect(scan.consumedFlagNames.has("type")).toBe(true);
      expect(scan.occurrences.get("domains")).toEqual(["-t"]);
      expect(scan.positionals).toEqual(["saml"]);
    });

    test("consumed `-t=saml` and `-tsaml` shorthand forms are tracked too", () => {
      const inline = pflagArgvScan(["sso", "add", "--domains", "-t=saml"], ADD_PATH, ADD_SPEC);
      expect(inline.occurrences.has("type")).toBe(false);
      expect(inline.consumedFlagNames.has("type")).toBe(true);
      const glued = pflagArgvScan(["sso", "add", "--domains", "-tsaml"], ADD_PATH, ADD_SPEC);
      expect(glued.occurrences.has("type")).toBe(false);
      expect(glued.consumedFlagNames.has("type")).toBe(true);
    });

    test("a consumed unmapped shorthand records no name", () => {
      const scan = pflagArgvScan(["sso", "add", "--domains", "-h"], ADD_PATH, ADD_SPEC);
      expect(scan.occurrences.get("domains")).toEqual(["-h"]);
      expect(scan.consumedFlagNames.size).toBe(0);
    });

    test("a shorthand `-t` occurrence coexists with a consumed `--type` token", () => {
      // pflag: `-t saml` sets type; `--domains` then swallows `--type`. The
      // flag IS changed, so required-flag emulation must not fire.
      const scan = pflagArgvScan(
        ["sso", "add", "-t", "saml", "--domains", "--type", "saml"],
        ADD_PATH,
        ADD_SPEC,
      );
      expect(scan.occurrences.get("type")).toEqual(["saml"]);
      expect(scan.consumedFlagNames.has("type")).toBe(true);
    });

    test("a consumed `--` records no name", () => {
      const scan = pflagArgvScan(["sso", "add", "--domains", "--", "x"], ADD_PATH, ADD_SPEC);
      expect(scan.occurrences.get("domains")).toEqual(["--"]);
      expect(scan.consumedFlagNames.size).toBe(0);
      expect(scan.positionals).toEqual(["x"]);
    });
  });
});

describe("cobraMutuallyExclusiveErrorMessage", () => {
  test("byte-matches cobra's validateExclusiveFlagGroups template", () => {
    expect(
      cobraMutuallyExclusiveErrorMessage(
        ["use-api", "use-docker", "legacy-bundle"],
        ["use-docker", "use-api"],
      ),
    ).toBe(
      "if any flags in the group [use-api use-docker legacy-bundle] are set none of the others can be; [use-api use-docker] were all set",
    );
  });

  test("sorts the changed subset alphabetically regardless of input order", () => {
    expect(
      cobraMutuallyExclusiveErrorMessage(
        ["use-api", "use-docker", "legacy-bundle"],
        ["use-api", "legacy-bundle"],
      ),
    ).toBe(
      "if any flags in the group [use-api use-docker legacy-bundle] are set none of the others can be; [legacy-bundle use-api] were all set",
    );
  });
});
