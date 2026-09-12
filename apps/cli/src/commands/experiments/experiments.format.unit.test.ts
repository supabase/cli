import { describe, expect, it } from "vitest";
import { readExperimentValues, renderExperimentOutcomes } from "./experiments.format.ts";

describe("readExperimentValues", () => {
  it("reads the experiment booleans an [experimental] table declares", () => {
    expect(
      readExperimentValues(
        "toml",
        'project_id = "x"\n\n[experimental]\ncompute = true\nstack = false\n',
      ),
    ).toEqual({ compute: true, stack: false });
  });

  it("reads the same keys out of a JSON document", () => {
    expect(readExperimentValues("json", '{"experimental":{"compute":true}}')).toEqual({
      compute: true,
    });
  });

  it("ignores [experimental] keys that are not experiments and not booleans", () => {
    expect(
      readExperimentValues("toml", '[experimental]\norioledb_version = ""\ncompute = "yes"\n'),
    ).toEqual({});
  });

  it("reports no experiments for a document with no [experimental] table", () => {
    expect(readExperimentValues("toml", 'project_id = "x"\n')).toEqual({});
  });

  it("reports no experiments when the document's root is not a table", () => {
    expect(readExperimentValues("json", "[1, 2]")).toEqual({});
  });

  it("reports no experiments when [experimental] is not a table", () => {
    expect(readExperimentValues("json", '{"experimental": 3}')).toEqual({});
  });

  // The duplicate-table case the command exists to diagnose: `applyConfigEdits` names it,
  // so this reader only has to decline to guess.
  it("returns undefined for a document that does not parse", () => {
    expect(readExperimentValues("toml", "[experimental]\ncompute = true\n\n[experimental]\n")).toBe(
      undefined,
    );
    expect(readExperimentValues("json", "{oops")).toBe(undefined);
  });
});

describe("renderExperimentOutcomes", () => {
  it("reports a write and a no-op differently", () => {
    expect(
      renderExperimentOutcomes({
        enabled: true,
        configPath: "/p/supabase/config.toml",
        outcomes: [
          { feature: "compute", previous: false, changed: true, envOverride: undefined },
          { feature: "stack", previous: true, changed: false, envOverride: undefined },
        ],
      }),
    ).toBe(
      "Enabled compute in /p/supabase/config.toml.\n" +
        "stack is already enabled in /p/supabase/config.toml.\n",
    );
  });

  it("uses the disable vocabulary when disabling", () => {
    expect(
      renderExperimentOutcomes({
        enabled: false,
        configPath: "/p/supabase/config.toml",
        outcomes: [
          { feature: "compute", previous: true, changed: true, envOverride: undefined },
          { feature: "stack", previous: false, changed: false, envOverride: undefined },
        ],
      }),
    ).toBe(
      "Disabled compute in /p/supabase/config.toml.\n" +
        "stack is already disabled in /p/supabase/config.toml.\n",
    );
  });

  it("names the environment variable that will ignore what was just written", () => {
    expect(
      renderExperimentOutcomes({
        enabled: true,
        configPath: "/p/supabase/config.toml",
        outcomes: [{ feature: "compute", previous: false, changed: true, envOverride: "0" }],
      }),
    ).toBe(
      "Enabled compute in /p/supabase/config.toml.\n" +
        "Note: SUPABASE_EXPERIMENTAL_COMPUTE=0 takes precedence over /p/supabase/config.toml for this shell.\n",
    );
  });
});
