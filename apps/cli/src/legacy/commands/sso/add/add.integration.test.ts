import { writeFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "@effect/vitest";
import { Effect, Exit, Layer, Option, Stdio } from "effect";
import * as HttpClientResponse from "effect/unstable/http/HttpClientResponse";

import { mockAnalytics, mockOutput } from "../../../../../tests/helpers/mocks.ts";
import {
  buildLegacyTestRuntime,
  LEGACY_DEFAULT_API_URL,
  LEGACY_VALID_REF,
  mockLegacyCliConfig,
  mockLegacyLinkedProjectCacheTracked,
  mockLegacyPlatformApi,
  mockLegacyTelemetryStateTracked,
  useLegacyTempWorkdir,
} from "../../../../../tests/helpers/legacy-mocks.ts";
import { LegacyProfileFlag } from "../../../../shared/legacy/global-flags.ts";
import { EventUpgradeSuggested } from "../../../../shared/telemetry/event-catalog.ts";
import { legacySsoAdd } from "./add.handler.ts";

const RESPONSE_PROVIDER = {
  id: "b5ae62f9-ef1d-4f11-a02b-731c8bbb11e8",
  saml: {
    id: "saml-1",
    entity_id: "https://example.com",
    attribute_mapping: { keys: { a: { name: "xyz", default: 3 } } },
  },
  domains: [{ id: "d1", domain: "example.com" }],
};

const tempRoot = useLegacyTempWorkdir("supabase-sso-add-int-");

interface SetupOpts {
  format?: "text" | "json" | "stream-json";
  goOutput?: "env" | "pretty" | "json" | "toml" | "yaml";
  status?: number;
  body?: unknown;
  network?: "fail";
  upgradeGate?: "gated" | "notGated";
  // Metadata-URL fetch responses keyed by URL prefix.
  metadataUrlResponse?: { status: number; body: string };
  /**
   * Raw argv the handler sees via `Stdio.Stdio` — drives the pflag-faithful
   * scan (`pflagArgvScan`) behind the required-flag check, the mutex check,
   * and the value reconciliation. Defaults to a bare invocation with no optional
   * flags present; tests that pass flags must pass matching argv here
   * (usually via `cliArgsFor`), exactly as the real parser guarantees.
   */
  cliArgs?: ReadonlyArray<string>;
  /**
   * The Effect-parsed `--profile` value (`LegacyProfileFlag`), which the real
   * parser sets for any `--profile` it accepted. Tests whose `cliArgs` carry a
   * `--profile` the parser would have consumed must provide it, exactly as the
   * real CLI tree would.
   */
  profileFlag?: string;
}

function jsonResponse(
  request: Parameters<typeof HttpClientResponse.fromWeb>[0],
  status: number,
  body: unknown,
) {
  return HttpClientResponse.fromWeb(
    request,
    new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    }),
  );
}

function textResponse(
  request: Parameters<typeof HttpClientResponse.fromWeb>[0],
  status: number,
  body: string,
) {
  return HttpClientResponse.fromWeb(
    request,
    new Response(body, {
      status,
      headers: { "content-type": "application/xml" },
    }),
  );
}

function setup(opts: SetupOpts = {}) {
  const out = mockOutput({ format: opts.format ?? "text" });
  const analytics = mockAnalytics();
  const telemetry = mockLegacyTelemetryStateTracked();
  const cache = mockLegacyLinkedProjectCacheTracked();

  const status = opts.status ?? 201;
  const body = opts.body ?? RESPONSE_PROVIDER;
  const gate = opts.upgradeGate;
  const metadataUrlResponse = opts.metadataUrlResponse;

  const api = mockLegacyPlatformApi({
    network: opts.network,
    handler: (request) => {
      const url = request.url;
      if (url.includes("/config/auth/sso/providers") && request.method === "POST") {
        return Effect.succeed(jsonResponse(request, status, body));
      }
      if (metadataUrlResponse !== undefined && url.startsWith("https://idp.example.com")) {
        return Effect.succeed(
          textResponse(request, metadataUrlResponse.status, metadataUrlResponse.body),
        );
      }
      if (url.endsWith(`/v1/projects/${LEGACY_VALID_REF}`)) {
        if (gate === undefined) return Effect.succeed(jsonResponse(request, 404, {}));
        return Effect.succeed(
          jsonResponse(request, 200, {
            id: LEGACY_VALID_REF,
            ref: LEGACY_VALID_REF,
            organization_id: "org-id",
            organization_slug: "acme",
            name: "Test",
            region: "us-east-1",
            created_at: "2023-01-01T00:00:00Z",
            status: "ACTIVE_HEALTHY",
            database: {
              host: "db.example.com",
              version: "15",
              postgres_engine: "15",
              release_channel: "ga",
            },
          }),
        );
      }
      if (url.includes("/v1/organizations/acme/entitlements")) {
        return Effect.succeed(
          jsonResponse(request, 200, {
            entitlements: [
              {
                feature: { key: "auth.saml_2", type: "boolean" },
                hasAccess: gate === "notGated",
                type: "boolean",
                config: { enabled: false },
              },
            ],
          }),
        );
      }
      return Effect.succeed(jsonResponse(request, 404, {}));
    },
  });

  const cliConfig = mockLegacyCliConfig({ workdir: tempRoot.current });
  const layer = Layer.mergeAll(
    buildLegacyTestRuntime({
      out,
      api: { layer: api.layer, httpClientLayer: api.httpClientLayer },
      cliConfig,
      telemetry: telemetry.layer,
      linkedProjectCache: cache.layer,
      analytics,
      goOutput: opts.goOutput === undefined ? Option.none() : Option.some(opts.goOutput),
    }),
    Stdio.layerTest({
      args: Effect.succeed(opts.cliArgs ?? ["sso", "add", "--type", "saml"]),
    }),
    opts.profileFlag === undefined
      ? Layer.empty
      : Layer.succeed(LegacyProfileFlag, opts.profileFlag),
  );

  return { layer, out, api, analytics, telemetry, cache };
}

const defaultFlags = {
  projectRef: Option.none<string>(),
  type: "saml" as const,
  domains: [] as ReadonlyArray<string>,
  metadataFile: Option.none<string>(),
  metadataUrl: Option.none<string>(),
  skipUrlValidation: false,
  attributeMappingFile: Option.none<string>(),
  nameIdFormat: Option.none<
    | "urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress"
    | "urn:oasis:names:tc:SAML:1.1:nameid-format:unspecified"
    | "urn:oasis:names:tc:SAML:2.0:nameid-format:persistent"
    | "urn:oasis:names:tc:SAML:2.0:nameid-format:transient"
  >(),
};

/**
 * Serializes a flags record into the raw argv the real CLI would have been
 * invoked with. The handler reconciles every value it acts on against a
 * pflag-faithful scan of this argv, so tests must keep the two consistent —
 * a flag passed in the record but absent from argv reconciles to "not set",
 * exactly as it would be for a real invocation.
 */
function cliArgsFor(flags: typeof defaultFlags): ReadonlyArray<string> {
  const argv: string[] = ["sso", "add", "--type", flags.type];
  if (Option.isSome(flags.projectRef)) {
    argv.push("--project-ref", flags.projectRef.value);
  }
  for (const domain of flags.domains) {
    argv.push("--domains", domain);
  }
  if (Option.isSome(flags.metadataFile)) {
    argv.push("--metadata-file", flags.metadataFile.value);
  }
  if (Option.isSome(flags.metadataUrl)) {
    argv.push("--metadata-url", flags.metadataUrl.value);
  }
  if (flags.skipUrlValidation) {
    argv.push("--skip-url-validation");
  }
  if (Option.isSome(flags.attributeMappingFile)) {
    argv.push("--attribute-mapping-file", flags.attributeMappingFile.value);
  }
  if (Option.isSome(flags.nameIdFormat)) {
    argv.push("--name-id-format", flags.nameIdFormat.value);
  }
  return argv;
}

describe("legacy sso add integration", () => {
  it.live("POSTs to /v1/projects/{ref}/config/auth/sso/providers with type=saml", () => {
    const { layer, api } = setup();
    return Effect.gen(function* () {
      yield* legacySsoAdd(defaultFlags);
      const req = api.requests.find((r) => r.method === "POST");
      expect(req).toBeDefined();
      expect(req?.url).toContain(`/v1/projects/${LEGACY_VALID_REF}/config/auth/sso/providers`);
      expect((req?.body as { type?: string })?.type).toBe("saml");
    }).pipe(Effect.provide(layer));
  });

  it.live(
    "mutex check: --metadata-file + --metadata-url fails with cobra's exact error text",
    () => {
      const { layer } = setup({
        cliArgs: [
          "sso",
          "add",
          "--type",
          "saml",
          "--metadata-file",
          "/tmp/missing.xml",
          "--metadata-url",
          "https://idp.example.com/m",
        ],
      });
      return Effect.gen(function* () {
        const exit = yield* Effect.exit(
          legacySsoAdd({
            ...defaultFlags,
            metadataFile: Option.some("/tmp/missing.xml"),
            metadataUrl: Option.some("https://idp.example.com/m"),
          }),
        );
        expect(Exit.isFailure(exit)).toBe(true);
        if (Exit.isFailure(exit)) {
          const dump = JSON.stringify(exit.cause);
          expect(dump).toContain("LegacySsoMutexFlagError");
          // Byte-matches cobra's `validateExclusiveFlagGroups` template
          // (`flag_groups.go:204`): group in Go's registration order
          // (`cmd/sso.go:164`), changed flags sorted alphabetically.
          expect(dump).toContain(
            "if any flags in the group [metadata-file metadata-url] are set none of the others can be; [metadata-file metadata-url] were all set",
          );
        }
      }).pipe(Effect.provide(layer));
    },
  );

  it.live(
    "mutex check: an explicit but empty --metadata-file= still conflicts with --metadata-url (changed, not truthy)",
    () => {
      // `--metadata-file=` parses to an empty string, but cobra's
      // `pflag.Changed` tracks that the flag was passed at all, not the
      // resulting value — the mutex must trip on an explicit empty value,
      // and with cobra's exact template, not the old hand-written message.
      const { layer } = setup({
        cliArgs: [
          "sso",
          "add",
          "--type",
          "saml",
          "--metadata-file=",
          "--metadata-url",
          "https://idp.example.com/m",
        ],
      });
      return Effect.gen(function* () {
        const exit = yield* Effect.exit(
          legacySsoAdd({
            ...defaultFlags,
            metadataFile: Option.some(""),
            metadataUrl: Option.some("https://idp.example.com/m"),
          }),
        );
        expect(Exit.isFailure(exit)).toBe(true);
        if (Exit.isFailure(exit)) {
          const dump = JSON.stringify(exit.cause);
          expect(dump).toContain("LegacySsoMutexFlagError");
          expect(dump).toContain(
            "if any flags in the group [metadata-file metadata-url] are set none of the others can be; [metadata-file metadata-url] were all set",
          );
        }
      }).pipe(Effect.provide(layer));
    },
  );

  it.live(
    "mutex check: a bare --metadata-file followed by --metadata-url is not a violation, and the consumed token is the file",
    () => {
      // pflag's `--flag arg` branch consumes the very next argv token as the
      // value unconditionally (`flag.go:1013-1031`), so real cobra parses
      // this as `metadata-file` receiving the literal value
      // `"--metadata-url"` — `metadata-url` is never parsed as its own flag
      // and stays unset. The raw-argv scan must reach the same conclusion:
      // no mutex violation, and the handler must then behave exactly like Go
      // — try to open a file literally named `--metadata-url` (Go: `failed
      // to open metadata file: open --metadata-url: no such file or
      // directory`), not silently succeed with no metadata at all.
      const { layer, api } = setup({
        cliArgs: ["sso", "add", "--type", "saml", "--metadata-file", "--metadata-url"],
      });
      return Effect.gen(function* () {
        const exit = yield* Effect.exit(legacySsoAdd(defaultFlags));
        expect(Exit.isFailure(exit)).toBe(true);
        if (Exit.isFailure(exit)) {
          const dump = JSON.stringify(exit.cause);
          expect(dump).toContain("LegacySsoAddMetadataFileError");
          expect(dump).toContain("failed to open metadata file");
        }
        expect(api.requests.some((r) => r.method === "POST")).toBe(false);
      }).pipe(Effect.provide(layer));
    },
  );

  it.live(
    "reconciles project-ref consuming --metadata-file: fails ref validation like Go, never reads metadata",
    () => {
      // `sso add --type saml --project-ref --metadata-file file.xml
      // --metadata-url URL`: pflag hands `--metadata-file` to `--project-ref`
      // as its value, `file.xml` becomes a positional, and only
      // `metadata-url` is set — no mutex violation. The Effect parser instead
      // drops the bare `--project-ref` and parses both metadata options, so
      // without reconciliation the handler would read `file.xml` and POST
      // `metadata_xml` — an API call Go never makes: Go fails
      // `AssertProjectRefIsValid` on the value `--metadata-file`
      // (`internal/utils/flags/project_ref.go:57-59`) before touching
      // metadata. The reconciled handler must fail with Go's exact
      // invalid-ref error and make no API request.
      const { layer, api } = setup({
        cliArgs: [
          "sso",
          "add",
          "--type",
          "saml",
          "--project-ref",
          "--metadata-file",
          "file.xml",
          "--metadata-url",
          "https://idp.example.com/m",
        ],
      });
      return Effect.gen(function* () {
        const exit = yield* Effect.exit(
          legacySsoAdd({
            ...defaultFlags,
            metadataFile: Option.some("file.xml"),
            metadataUrl: Option.some("https://idp.example.com/m"),
          }),
        );
        expect(Exit.isFailure(exit)).toBe(true);
        if (Exit.isFailure(exit)) {
          const dump = JSON.stringify(exit.cause);
          expect(dump).toContain("LegacyInvalidProjectRefError");
          expect(dump).toContain("Invalid project ref format. Must be like");
        }
        expect(api.requests.some((r) => r.method === "POST")).toBe(false);
      }).pipe(Effect.provide(layer));
    },
  );

  it.live(
    "required emulation: a bare --domains consuming --type fails the required-flag check, no POST",
    () => {
      // `sso add --domains --type saml`: pflag hands `--type` to `--domains`
      // as its value and `saml` becomes a positional — `type` is never
      // marked changed, so Go fails cobra's `ValidateRequiredFlags`
      // (`command.go:1007`, `MarkFlagRequired("type")` at `cmd/sso.go:165`)
      // before `RunE` and never POSTs. The Effect parser read `--type saml`
      // as a normal flag, so the handler must re-derive the required check
      // from the scan (PR #5974 review).
      const { layer, api } = setup({
        cliArgs: ["sso", "add", "--domains", "--type", "saml"],
      });
      return Effect.gen(function* () {
        const exit = yield* Effect.exit(legacySsoAdd(defaultFlags));
        expect(Exit.isFailure(exit)).toBe(true);
        if (Exit.isFailure(exit)) {
          const dump = JSON.stringify(exit.cause);
          expect(dump).toContain("LegacySsoAddRequiredFlagError");
          expect(dump).toContain('required flag(s) \\"type\\" not set');
        }
        expect(api.requests.length).toBe(0);
      }).pipe(Effect.provide(layer));
    },
  );

  it.live("required emulation: the required-flag error wins over a mutex violation", () => {
    // cobra runs `ValidateRequiredFlags` (`command.go:1007`) before
    // `ValidateFlagGroups` (`command.go:1010`), so when `--domains` swallows
    // `--type` AND both metadata flags are set, Go reports the required-flag
    // error, not the mutex template (binary-verified).
    const { layer, api } = setup({
      cliArgs: [
        "sso",
        "add",
        "--domains",
        "--type",
        "saml",
        "--metadata-file",
        "a.xml",
        "--metadata-url",
        "https://idp.example.com/m",
      ],
    });
    return Effect.gen(function* () {
      const exit = yield* Effect.exit(
        legacySsoAdd({
          ...defaultFlags,
          metadataFile: Option.some("a.xml"),
          metadataUrl: Option.some("https://idp.example.com/m"),
        }),
      );
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        const dump = JSON.stringify(exit.cause);
        expect(dump).toContain("LegacySsoAddRequiredFlagError");
        expect(dump).not.toContain("LegacySsoMutexFlagError");
      }
      expect(api.requests.length).toBe(0);
    }).pipe(Effect.provide(layer));
  });

  it.live(
    "workdir emulation: --workdir consuming --metadata-file fails at Go's chdir, never POSTs",
    () => {
      // `sso add --type saml --project-ref <ref> --workdir --metadata-file
      // missing.xml`: pflag binds `"--metadata-file"` to the persistent
      // `--workdir` and Go's `ChangeWorkDir` (`cmd/root.go:104`,
      // `misc.go:238-257`) exits before `RunE` with zero HTTP traffic. The
      // Effect parser refused the flag-shaped value (workdir stayed unset)
      // and read `missing.xml` as metadata — without the workdir emulation
      // the reconciliation discarded that metadata and POSTed a provider Go
      // never creates (binary-verified, PR #5974 review round 6).
      const { layer, api } = setup({
        cliArgs: [
          "sso",
          "add",
          "--type",
          "saml",
          "--project-ref",
          LEGACY_VALID_REF,
          "--workdir",
          "--metadata-file",
          "missing.xml",
        ],
      });
      return Effect.gen(function* () {
        const exit = yield* Effect.exit(
          legacySsoAdd({
            ...defaultFlags,
            projectRef: Option.some(LEGACY_VALID_REF),
            metadataFile: Option.some("missing.xml"),
          }),
        );
        expect(Exit.isFailure(exit)).toBe(true);
        if (Exit.isFailure(exit)) {
          const dump = JSON.stringify(exit.cause);
          expect(dump).toContain("LegacyPflagWorkdirError");
          expect(dump).toContain(
            "failed to change workdir: chdir --metadata-file: no such file or directory",
          );
        }
        expect(api.requests.length).toBe(0);
      }).pipe(Effect.provide(layer));
    },
  );

  it.live(
    "workdir emulation: the chdir failure wins over required-type and mutex violations",
    () => {
      // Go's `ChangeWorkDir` runs from `PersistentPreRunE` (`command.go:986`)
      // — before `ValidateRequiredFlags` (`command.go:1007`) and
      // `ValidateFlagGroups` (`command.go:1010`) — so a missing workdir beats
      // both the missing required `--type` and the metadata mutex
      // (binary-verified against apps/cli-go, PR #5974 review round 6).
      const { layer, api } = setup({
        cliArgs: [
          "sso",
          "add",
          "--workdir",
          "/nonexistent-sso-add-workdir",
          "--metadata-file",
          "a.xml",
          "--metadata-url",
          "https://idp.example.com/m",
        ],
      });
      return Effect.gen(function* () {
        const exit = yield* Effect.exit(
          legacySsoAdd({
            ...defaultFlags,
            metadataFile: Option.some("a.xml"),
            metadataUrl: Option.some("https://idp.example.com/m"),
          }),
        );
        expect(Exit.isFailure(exit)).toBe(true);
        if (Exit.isFailure(exit)) {
          const dump = JSON.stringify(exit.cause);
          expect(dump).toContain("LegacyPflagWorkdirError");
          expect(dump).toContain(
            "failed to change workdir: chdir /nonexistent-sso-add-workdir: no such file or directory",
          );
          expect(dump).not.toContain("LegacySsoAddRequiredFlagError");
          expect(dump).not.toContain("LegacySsoMutexFlagError");
        }
        expect(api.requests.length).toBe(0);
      }).pipe(Effect.provide(layer));
    },
  );

  it.live("workdir emulation: an existing --workdir directory proceeds to the POST", () => {
    // Go chdir's into an existing workdir and continues to `RunE` — the
    // emulation must only reject what `os.Chdir` would reject.
    const { layer, api } = setup({
      cliArgs: ["sso", "add", "--type", "saml", "--workdir", tempRoot.current],
    });
    return Effect.gen(function* () {
      yield* legacySsoAdd(defaultFlags);
      const req = api.requests.find((r) => r.method === "POST");
      expect((req?.body as { type?: string })?.type).toBe("saml");
    }).pipe(Effect.provide(layer));
  });

  it.live("required emulation: a -t shorthand invocation POSTs normally", () => {
    // The scan resolves `-t saml` to a `type` occurrence via the shorthand
    // map (`cmd/sso.go:157` registers `VarP`), so a genuine shorthand
    // invocation must never trip the emulated required-flag check.
    const { layer, api } = setup({
      cliArgs: ["sso", "add", "-t", "saml"],
    });
    return Effect.gen(function* () {
      yield* legacySsoAdd(defaultFlags);
      const req = api.requests.find((r) => r.method === "POST");
      expect((req?.body as { type?: string })?.type).toBe("saml");
    }).pipe(Effect.provide(layer));
  });

  it.live(
    "required emulation: -t saml plus a consumed --type still POSTs, like pflag (type IS changed)",
    () => {
      // `-t saml --domains --type saml`: pflag sets `type` via the shorthand
      // first, then `--domains` swallows the long `--type` token — the flag
      // is changed, so Go proceeds and POSTs with `domains: ["--type"]`.
      const { layer, api } = setup({
        cliArgs: ["sso", "add", "-t", "saml", "--domains", "--type", "saml"],
      });
      return Effect.gen(function* () {
        yield* legacySsoAdd(defaultFlags);
        const req = api.requests.find((r) => r.method === "POST");
        expect(req).toBeDefined();
        const body = req?.body as { type?: string; domains?: string[] };
        expect(body?.type).toBe("saml");
        expect(body?.domains).toEqual(["--type"]);
      }).pipe(Effect.provide(layer));
    },
  );

  it.live(
    "required emulation: a bare --domains consuming -t fails the required-flag check, no POST",
    () => {
      // Binary-verified: `sso add --domains -t saml` (and `-t=saml`) fails
      // Go's required-flag check — pflag hands the `-t` token to `--domains`
      // as its value, so `type` is never marked changed and `saml` becomes a
      // positional (Go's add command has no Args validation and accepts it).
      // The Effect parser read `-t saml` as a normal flag, so without the
      // scan's consumed-shorthand tracking the handler would POST
      // `type: "saml"`, `domains: ["-t"]` (PR #5974 review round 3).
      const { layer, api } = setup({
        cliArgs: ["sso", "add", "--domains", "-t", "saml"],
      });
      return Effect.gen(function* () {
        const exit = yield* Effect.exit(legacySsoAdd(defaultFlags));
        expect(Exit.isFailure(exit)).toBe(true);
        if (Exit.isFailure(exit)) {
          const dump = JSON.stringify(exit.cause);
          expect(dump).toContain("LegacySsoAddRequiredFlagError");
          expect(dump).toContain('required flag(s) \\"type\\" not set');
        }
        expect(api.requests.length).toBe(0);
      }).pipe(Effect.provide(layer));
    },
  );

  it.live(
    "invalid-value emulation: a later invalid --type occurrence fails with pflag's shorthand-labelled error, no POST",
    () => {
      // `--type saml --type bogus`: the Effect parser resolves repeats
      // first-wins and never validates the rest, so it parses; pflag Sets
      // every occurrence in order and rejects `bogus` at ParseFlags —
      // before every hook, the required-flag check, and the POST
      // (binary-verified, PR #5974 review round 4). pflag names the flag
      // with its shorthand (`-t, --type`, errors.go:39-41).
      const { layer, api } = setup({
        cliArgs: ["sso", "add", "--type", "saml", "--type", "bogus"],
      });
      return Effect.gen(function* () {
        const exit = yield* Effect.exit(legacySsoAdd(defaultFlags));
        expect(Exit.isFailure(exit)).toBe(true);
        if (Exit.isFailure(exit)) {
          const dump = JSON.stringify(exit.cause);
          expect(dump).toContain("LegacySsoInvalidFlagValueError");
          expect(dump).toContain(
            'invalid argument \\"bogus\\" for \\"-t, --type\\" flag: must be one of [ saml ]',
          );
        }
        expect(api.requests.length).toBe(0);
      }).pipe(Effect.provide(layer));
    },
  );

  it.live(
    "invalid-value emulation: a later inline-empty --skip-url-validation= fails like pflag, no POST",
    () => {
      // `--skip-url-validation=false --skip-url-validation=`: the Effect
      // parser resolves repeats first-wins and never validates the second
      // occurrence, so it parses; pflag hands `""` to strconv.ParseBool
      // (`flag.go:1014-1016`) and aborts ParseFlags before every hook and
      // the POST — only a *bare* repeat means NoOptDefVal true
      // (binary-verified, PR #5974 review round 5).
      const { layer, api } = setup({
        cliArgs: [
          "sso",
          "add",
          "--type",
          "saml",
          "--skip-url-validation=false",
          "--skip-url-validation=",
          "--metadata-url",
          "https://idp.example.com/m",
        ],
      });
      return Effect.gen(function* () {
        const exit = yield* Effect.exit(
          legacySsoAdd({
            ...defaultFlags,
            skipUrlValidation: false, // Effect's first-wins parse
            metadataUrl: Option.some("https://idp.example.com/m"),
          }),
        );
        expect(Exit.isFailure(exit)).toBe(true);
        if (Exit.isFailure(exit)) {
          const dump = JSON.stringify(exit.cause);
          expect(dump).toContain("LegacySsoInvalidFlagValueError");
          expect(dump).toContain(
            'invalid argument \\"\\" for \\"--skip-url-validation\\" flag: strconv.ParseBool: parsing \\"\\": invalid syntax',
          );
        }
        expect(api.requests.length).toBe(0);
      }).pipe(Effect.provide(layer));
    },
  );

  it.live(
    "value reconciliation: repeated --skip-url-validation resolves last-wins like pflag and skips validation",
    () => {
      // `--skip-url-validation=false --skip-url-validation` ends true for
      // pflag (Sets every occurrence) but false for the Effect parser
      // (first-wins) — Go skips URL validation and POSTs the non-HTTPS URL
      // (binary-verified, PR #5974 review round 4).
      const { layer, api } = setup({
        cliArgs: [
          "sso",
          "add",
          "--type",
          "saml",
          "--skip-url-validation=false",
          "--skip-url-validation",
          "--metadata-url",
          "http://insecure.example.com/md",
        ],
      });
      return Effect.gen(function* () {
        yield* legacySsoAdd({
          ...defaultFlags,
          skipUrlValidation: false, // Effect's first-wins parse
          metadataUrl: Option.some("http://insecure.example.com/md"),
        });
        const req = api.requests.find((r) => r.method === "POST");
        expect((req?.body as { metadata_url?: string })?.metadata_url).toBe(
          "http://insecure.example.com/md",
        );
      }).pipe(Effect.provide(layer));
    },
  );

  it.live(
    "value reconciliation: repeated --name-id-format resolves last-wins like pflag in the POST body",
    () => {
      // pflag's Set runs per occurrence, so the last one wins; the Effect
      // parser resolved first-wins (binary-verified, PR #5974 review
      // round 4).
      const transient = "urn:oasis:names:tc:SAML:2.0:nameid-format:transient" as const;
      const persistent = "urn:oasis:names:tc:SAML:2.0:nameid-format:persistent";
      const { layer, api } = setup({
        cliArgs: [
          "sso",
          "add",
          "--type",
          "saml",
          `--name-id-format=${transient}`,
          `--name-id-format=${persistent}`,
        ],
      });
      return Effect.gen(function* () {
        yield* legacySsoAdd({
          ...defaultFlags,
          nameIdFormat: Option.some(transient), // Effect's first-wins parse
        });
        const req = api.requests.find((r) => r.method === "POST");
        expect((req?.body as { name_id_format?: string })?.name_id_format).toBe(persistent);
      }).pipe(Effect.provide(layer));
    },
  );

  it.live("missing-value emulation: a trailing bare --domains fails pflag parse, no POST", () => {
    // Binary-verified: `sso add --type saml --domains` errors
    // `flag needs an argument: --domains` — pflag fails `ParseFlags` (cobra
    // `command.go:919`) before the required-flag and mutex validations and
    // Go never POSTs. The Effect parser accepts the argv (the flag parses
    // as unset), so the handler must reject it before any side effect
    // (PR #5974 review round 3).
    const { layer, api } = setup({
      cliArgs: ["sso", "add", "--type", "saml", "--domains"],
    });
    return Effect.gen(function* () {
      const exit = yield* Effect.exit(legacySsoAdd(defaultFlags));
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        const dump = JSON.stringify(exit.cause);
        expect(dump).toContain("LegacySsoFlagNeedsArgumentError");
        expect(dump).toContain("flag needs an argument: --domains");
      }
      expect(api.requests.length).toBe(0);
    }).pipe(Effect.provide(layer));
  });

  it.live(
    "reconciles a bare --domains consuming --metadata-file: POSTs the domain pflag saw, no metadata",
    () => {
      // `--domains --metadata-file x.xml`: pflag appends the literal string
      // `--metadata-file` to the domains slice and `x.xml` becomes a
      // positional — `metadata-file` is never set. The Effect parser drops
      // the bare `--domains` and parses `--metadata-file x.xml` instead, so
      // without reconciliation the request body would carry `metadata_xml`
      // and no domains — the opposite of Go's body.
      const { layer, api } = setup({
        cliArgs: ["sso", "add", "--type", "saml", "--domains", "--metadata-file", "x.xml"],
      });
      return Effect.gen(function* () {
        yield* legacySsoAdd({ ...defaultFlags, metadataFile: Option.some("x.xml") });
        const req = api.requests.find((r) => r.method === "POST");
        expect(req).toBeDefined();
        const body = req?.body as { domains?: string[]; metadata_xml?: string };
        expect(body?.domains).toEqual(["--metadata-file"]);
        expect(body?.metadata_xml).toBeUndefined();
      }).pipe(Effect.provide(layer));
    },
  );

  it.live(
    "reconciles a bare --metadata-url consuming --name-id-format: validates the consumed token as the URL",
    () => {
      // `--metadata-url --name-id-format urn:…`: pflag hands
      // `--name-id-format` to `--metadata-url` as its value and the urn
      // becomes a positional — `name-id-format` is never set. Go then fails
      // URL validation on the literal string `--name-id-format`; the body
      // must not pick up the parsed name-id-format either.
      const { layer, api } = setup({
        cliArgs: [
          "sso",
          "add",
          "--type",
          "saml",
          "--metadata-url",
          "--name-id-format",
          "urn:oasis:names:tc:SAML:2.0:nameid-format:persistent",
        ],
      });
      return Effect.gen(function* () {
        const exit = yield* Effect.exit(
          legacySsoAdd({
            ...defaultFlags,
            nameIdFormat: Option.some("urn:oasis:names:tc:SAML:2.0:nameid-format:persistent"),
          }),
        );
        expect(Exit.isFailure(exit)).toBe(true);
        if (Exit.isFailure(exit)) {
          const dump = JSON.stringify(exit.cause);
          // URL validation runs against the consumed token, not the parsed
          // Option — `--name-id-format` is not a valid HTTPS URL, so the
          // command fails before any request, like Go.
          expect(dump).toContain("LegacySsoAddMetadataFileError");
          expect(dump).toContain("--name-id-format");
          expect(dump).toContain("Use --skip-url-validation to suppress this error");
        }
        expect(api.requests.some((r) => r.method === "POST")).toBe(false);
      }).pipe(Effect.provide(layer));
    },
  );

  it.live("falls back to the parsed domains when the scan's raw values are malformed CSV", () => {
    // Unreachable through the real CLI (the parser rejects malformed CSV at
    // parse time), but the reconciliation must not crash if the consumed
    // token is un-parseable — it keeps the parser's values instead.
    const { layer, api } = setup({
      cliArgs: ["sso", "add", "--type", "saml", "--domains", '--x"y'],
    });
    return Effect.gen(function* () {
      yield* legacySsoAdd({ ...defaultFlags, domains: ["fallback.example.com"] });
      const req = api.requests.find((r) => r.method === "POST");
      expect((req?.body as { domains?: string[] })?.domains).toEqual(["fallback.example.com"]);
    }).pipe(Effect.provide(layer));
  });

  it.live("reads metadata file and sends as metadata_xml", () => {
    const path = join(tempRoot.current, "good.xml");
    writeFileSync(path, '<?xml version="1.0"?><md/>');
    // A single metadata flag on the raw argv must sail through the mutex scan.
    const { layer, api } = setup({
      cliArgs: ["sso", "add", "--type", "saml", "--metadata-file", path],
    });
    return Effect.gen(function* () {
      yield* legacySsoAdd({ ...defaultFlags, metadataFile: Option.some(path) });
      const req = api.requests.find((r) => r.method === "POST");
      expect((req?.body as { metadata_xml?: string })?.metadata_xml).toContain("<md/>");
    }).pipe(Effect.provide(layer));
  });

  it.live("rejects non-UTF8 metadata file", () => {
    const path = join(tempRoot.current, "bad.xml");
    writeFileSync(path, Buffer.from([0xff, 0xfe, 0xfd]));
    const flags = { ...defaultFlags, metadataFile: Option.some(path) };
    const { layer } = setup({ cliArgs: cliArgsFor(flags) });
    return Effect.gen(function* () {
      const exit = yield* Effect.exit(legacySsoAdd(flags));
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        expect(JSON.stringify(exit.cause)).toContain("LegacySsoAddMetadataFileError");
      }
    }).pipe(Effect.provide(layer));
  });

  it.live("sends metadata_url verbatim when --skip-url-validation", () => {
    // A single metadata flag on the raw argv must sail through the mutex scan.
    const { layer, api } = setup({
      cliArgs: [
        "sso",
        "add",
        "--type",
        "saml",
        "--metadata-url",
        "https://idp.example.com/m",
        "--skip-url-validation",
      ],
    });
    return Effect.gen(function* () {
      yield* legacySsoAdd({
        ...defaultFlags,
        metadataUrl: Option.some("https://idp.example.com/m"),
        skipUrlValidation: true,
      });
      const req = api.requests.find((r) => r.method === "POST");
      expect((req?.body as { metadata_url?: string })?.metadata_url).toBe(
        "https://idp.example.com/m",
      );
    }).pipe(Effect.provide(layer));
  });

  it.live("validates HTTPS metadata URL when not skipped — success path", () => {
    const flags = {
      ...defaultFlags,
      metadataUrl: Option.some("https://idp.example.com/m"),
      skipUrlValidation: false,
    };
    const { layer, api } = setup({
      metadataUrlResponse: { status: 200, body: '<?xml version="1.0"?><md/>' },
      cliArgs: cliArgsFor(flags),
    });
    return Effect.gen(function* () {
      yield* legacySsoAdd(flags);
      const req = api.requests.find((r) => r.method === "POST");
      expect((req?.body as { metadata_url?: string })?.metadata_url).toBe(
        "https://idp.example.com/m",
      );
    }).pipe(Effect.provide(layer));
  });

  it.live("rejects non-HTTPS metadata URL with Go-format message", () => {
    const flags = {
      ...defaultFlags,
      metadataUrl: Option.some("http://idp.example.com/m"),
      skipUrlValidation: false,
    };
    const { layer } = setup({ cliArgs: cliArgsFor(flags) });
    return Effect.gen(function* () {
      const exit = yield* Effect.exit(legacySsoAdd(flags));
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        const dump = JSON.stringify(exit.cause);
        expect(dump).toContain("only HTTPS Metadata URLs are supported");
        expect(dump).toContain("Use --skip-url-validation to suppress this error");
      }
    }).pipe(Effect.provide(layer));
  });

  it.live("reads attribute mapping JSON and preserves user-defined `default` field", () => {
    const path = join(tempRoot.current, "mapping.json");
    writeFileSync(path, JSON.stringify({ keys: { a: { default: 3 } } }));
    const flags = { ...defaultFlags, attributeMappingFile: Option.some(path) };
    const { layer, api } = setup({ cliArgs: cliArgsFor(flags) });
    return Effect.gen(function* () {
      yield* legacySsoAdd(flags);
      const req = api.requests.find((r) => r.method === "POST");
      const mapping = (req?.body as { attribute_mapping?: { keys: { a: { default: number } } } })
        ?.attribute_mapping;
      expect(mapping?.keys.a.default).toBe(3);
    }).pipe(Effect.provide(layer));
  });

  it.live("sends domains array verbatim", () => {
    const flags = { ...defaultFlags, domains: ["a.com", "b.com"] };
    const { layer, api } = setup({ cliArgs: cliArgsFor(flags) });
    return Effect.gen(function* () {
      yield* legacySsoAdd(flags);
      const req = api.requests.find((r) => r.method === "POST");
      expect((req?.body as { domains?: string[] })?.domains).toEqual(["a.com", "b.com"]);
    }).pipe(Effect.provide(layer));
  });

  it.live("renders single-provider markdown in text mode", () => {
    const { layer, out } = setup();
    return Effect.gen(function* () {
      yield* legacySsoAdd(defaultFlags);
      expect(out.stdoutText).toContain("IDENTITY PROVIDER ID");
      expect(out.stdoutText).toContain(RESPONSE_PROVIDER.id);
    }).pipe(Effect.provide(layer));
  });

  it.live("Go --output=env returns no output", () => {
    const { layer, out } = setup({ goOutput: "env" });
    return Effect.gen(function* () {
      yield* legacySsoAdd(defaultFlags);
      expect(out.stdoutText).toBe("");
    }).pipe(Effect.provide(layer));
  });

  it.live("Go --output=json encodes response verbatim", () => {
    const { layer, out } = setup({ goOutput: "json" });
    return Effect.gen(function* () {
      yield* legacySsoAdd(defaultFlags);
      expect(out.stdoutText).toContain(RESPONSE_PROVIDER.id);
    }).pipe(Effect.provide(layer));
  });

  it.live("TS --output-format=json emits success", () => {
    const { layer, out } = setup({ format: "json" });
    return Effect.gen(function* () {
      yield* legacySsoAdd(defaultFlags);
      expect(out.messages.some((m) => m.type === "success")).toBe(true);
    }).pipe(Effect.provide(layer));
  });

  it.live("reports SAML-disabled error on 404", () => {
    const { layer } = setup({ status: 404, body: {} });
    return Effect.gen(function* () {
      const exit = yield* Effect.exit(legacySsoAdd(defaultFlags));
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        expect(JSON.stringify(exit.cause)).toContain("LegacySsoAddSamlDisabledError");
      }
    }).pipe(Effect.provide(layer));
  });

  it.live("fires cli_upgrade_suggested on 404 when entitlement is gated", () => {
    const { layer, analytics } = setup({ status: 404, body: {}, upgradeGate: "gated" });
    return Effect.gen(function* () {
      yield* Effect.exit(legacySsoAdd(defaultFlags));
      expect(analytics.captured.some((c) => c.event === EventUpgradeSuggested)).toBe(true);
    }).pipe(Effect.provide(layer));
  });

  it.live("reports unexpected-status error on 500", () => {
    const { layer } = setup({ status: 500, body: { error: "boom" } });
    return Effect.gen(function* () {
      const exit = yield* Effect.exit(legacySsoAdd(defaultFlags));
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        const dump = JSON.stringify(exit.cause);
        expect(dump).toContain("LegacySsoAddUnexpectedStatusError");
        expect(dump).toContain("Unexpected error adding identity provider");
      }
    }).pipe(Effect.provide(layer));
  });

  it.live("flushes telemetry + linked-project cache on success and failure", () => {
    const { layer, telemetry, cache } = setup({ status: 500, body: {} });
    return Effect.gen(function* () {
      yield* Effect.exit(legacySsoAdd(defaultFlags));
      expect(telemetry.flushed).toBe(true);
      expect(cache.cached).toBe(true);
    }).pipe(Effect.provide(layer));
  });

  it.live("Go --output=yaml encodes response verbatim", () => {
    const { layer, out } = setup({ goOutput: "yaml" });
    return Effect.gen(function* () {
      yield* legacySsoAdd(defaultFlags);
      expect(out.stdoutText).toContain(RESPONSE_PROVIDER.id);
    }).pipe(Effect.provide(layer));
  });

  it.live("Go --output=toml encodes response verbatim", () => {
    const { layer, out } = setup({ goOutput: "toml" });
    return Effect.gen(function* () {
      yield* legacySsoAdd(defaultFlags);
      expect(out.stdoutText).toContain(RESPONSE_PROVIDER.id);
    }).pipe(Effect.provide(layer));
  });

  it.live("preserves attribute_mapping `default` field in POST body", () => {
    const path = join(tempRoot.current, "mapping.json");
    writeFileSync(path, JSON.stringify({ keys: { a: { default: 42 } } }));
    const flags = { ...defaultFlags, attributeMappingFile: Option.some(path) };
    const { layer, api } = setup({ cliArgs: cliArgsFor(flags) });
    return Effect.gen(function* () {
      yield* legacySsoAdd(flags);
      const req = api.requests.find((r) => r.method === "POST");
      const mapping = (req?.body as { attribute_mapping?: { keys: { a: { default: number } } } })
        ?.attribute_mapping;
      expect(mapping?.keys.a.default).toBe(42);
    }).pipe(Effect.provide(layer));
  });

  it.live("metadata URL fetch failure surfaces as add metadata file error", () => {
    const flags = {
      ...defaultFlags,
      metadataUrl: Option.some("https://idp.example.com/m"),
      skipUrlValidation: false,
    };
    const { layer } = setup({
      metadataUrlResponse: { status: 503, body: "<x/>" },
      cliArgs: cliArgsFor(flags),
    });
    return Effect.gen(function* () {
      const exit = yield* Effect.exit(legacySsoAdd(flags));
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        const dump = JSON.stringify(exit.cause);
        expect(dump).toContain("LegacySsoAddMetadataFileError");
        // Per Go's `create.go:47`: error tail is `… Use --skip-url-validation to suppress this error`
        // (no trailing period).
        expect(dump).toContain("Use --skip-url-validation to suppress this error");
      }
    }).pipe(Effect.provide(layer));
  });

  // Non-UTF-8 body coverage lives in `sso.saml.unit.test.ts` — the test runtime
  // here passes the response body through `Response`'s constructor which always
  // emits valid UTF-8 bytes regardless of the input string, so a byte-level
  // invalid sequence cannot be expressed without bypassing the Response API.

  it.live("malformed metadata URL surfaces invalid URI error", () => {
    const flags = {
      ...defaultFlags,
      metadataUrl: Option.some("::::not a url::::"),
      skipUrlValidation: false,
    };
    const { layer } = setup({ cliArgs: cliArgsFor(flags) });
    return Effect.gen(function* () {
      const exit = yield* Effect.exit(legacySsoAdd(flags));
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        expect(JSON.stringify(exit.cause)).toContain("LegacySsoAddMetadataFileError");
      }
    }).pipe(Effect.provide(layer));
  });

  it.live("nameIdFormat is forwarded in the request body when provided", () => {
    const flags = {
      ...defaultFlags,
      nameIdFormat: Option.some("urn:oasis:names:tc:SAML:2.0:nameid-format:persistent" as const),
    };
    const { layer, api } = setup({ cliArgs: cliArgsFor(flags) });
    return Effect.gen(function* () {
      yield* legacySsoAdd(flags);
      const req = api.requests.find((r) => r.method === "POST");
      expect((req?.body as { name_id_format?: string })?.name_id_format).toBe(
        "urn:oasis:names:tc:SAML:2.0:nameid-format:persistent",
      );
    }).pipe(Effect.provide(layer));
  });

  it.live("attribute mapping parse failure surfaces a tagged error", () => {
    const path = join(tempRoot.current, "malformed.json");
    writeFileSync(path, "{not json}");
    const flags = { ...defaultFlags, attributeMappingFile: Option.some(path) };
    const { layer } = setup({ cliArgs: cliArgsFor(flags) });
    return Effect.gen(function* () {
      const exit = yield* Effect.exit(legacySsoAdd(flags));
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        expect(JSON.stringify(exit.cause)).toContain("LegacySsoAddAttributeMappingFileError");
      }
    }).pipe(Effect.provide(layer));
  });

  // -------------------------------------------------------------------------
  // Profile emulation (PR #5974 review round 7): Go's `LoadProfile` runs from
  // the root `PersistentPreRunE` (`cmd/root.go:98-102`) on the pflag/viper-
  // effective `--profile`/`SUPABASE_PROFILE`, immediately before
  // `ChangeWorkDir` — it decides which API host receives the POST and aborts
  // the command when the profile cannot be loaded.
  // -------------------------------------------------------------------------

  const writeProfileYaml = (name: string, apiUrl: string): string => {
    const path = join(tempRoot.current, name);
    writeFileSync(
      path,
      [
        `name: ${name.replace(/\.[^.]*$/, "")}`,
        `api_url: ${apiUrl}`,
        `dashboard_url: ${apiUrl}/dashboard`,
        "project_host: supabase.co",
      ].join("\n"),
    );
    return path;
  };

  const withProfileEnv = (value: string | undefined) => {
    const previous = process.env["SUPABASE_PROFILE"];
    if (value === undefined) {
      delete process.env["SUPABASE_PROFILE"];
    } else {
      process.env["SUPABASE_PROFILE"] = value;
    }
    return Effect.sync(() => {
      if (previous === undefined) {
        delete process.env["SUPABASE_PROFILE"];
      } else {
        process.env["SUPABASE_PROFILE"] = previous;
      }
    });
  };

  it.live(
    "profile emulation: --domains consuming --profile POSTs to the env profile's host, not the parsed file's",
    () => {
      // `sso add --type saml --domains --profile alternate.yml`: pflag hands
      // `--profile` to `--domains` and never marks profile changed, so viper
      // falls to SUPABASE_PROFILE — while the Effect parser read
      // `alternate.yml` as the profile and built `LegacyCliConfig` from it.
      // Binary-verified (the demonstrated divergent input, PR #5974 round 7):
      // Go POSTs `{"domains":["--profile"],"type":"saml"}` to the env
      // profile's api_url; the parsed file's host receives nothing.
      const envProfile = writeProfileYaml("env-profile.yml", "http://reconciled.example");
      const alternate = writeProfileYaml("alternate.yml", "http://alternate.example");
      const restoreEnv = withProfileEnv(envProfile);
      const { layer, api, cache } = setup({
        cliArgs: ["sso", "add", "--type", "saml", "--domains", "--profile", alternate],
        profileFlag: alternate,
      });
      return Effect.gen(function* () {
        yield* legacySsoAdd(defaultFlags);
        const posts = api.requests.filter((r) => r.method === "POST");
        expect(posts.length).toBe(1);
        expect(posts[0]?.url).toBe(
          `http://reconciled.example/v1/projects/${LEGACY_VALID_REF}/config/auth/sso/providers`,
        );
        expect((posts[0]?.body as { domains?: ReadonlyArray<string> })?.domains).toEqual([
          "--profile",
        ]);
        // The linked-project cache fill targets the reconciled host too
        // (Go's ensureProjectGroupsCached uses the process-wide profile).
        expect(cache.cachedApiUrl).toBe("http://reconciled.example");
      }).pipe(Effect.ensuring(restoreEnv), Effect.provide(layer));
    },
  );

  it.live(
    "profile emulation: --profile consuming a flag-shaped token fails LoadProfile, never POSTs",
    () => {
      // `sso add --type saml --profile --metadata-url u`: pflag binds
      // `"--metadata-url"` as the profile value; viper's extension gate
      // rejects it before any request (binary-verified: `failed to read
      // profile: Unsupported Config Type ""`).
      const restoreEnv = withProfileEnv(undefined);
      const { layer, api } = setup({
        cliArgs: [
          "sso",
          "add",
          "--type",
          "saml",
          "--profile",
          "--metadata-url",
          "https://idp.example.com/m",
        ],
      });
      return Effect.gen(function* () {
        const exit = yield* Effect.exit(
          legacySsoAdd({
            ...defaultFlags,
            metadataUrl: Option.some("https://idp.example.com/m"),
          }),
        );
        expect(Exit.isFailure(exit)).toBe(true);
        if (Exit.isFailure(exit)) {
          const dump = JSON.stringify(exit.cause);
          expect(dump).toContain("LegacyProfileLoadError");
          expect(dump).toContain(`failed to read profile: Unsupported Config Type \\"\\"`);
        }
        expect(api.requests.length).toBe(0);
      }).pipe(Effect.ensuring(restoreEnv), Effect.provide(layer));
    },
  );

  it.live("profile emulation: repeated --profile resolves last-wins, matching pflag", () => {
    // `--profile a.yml --profile b.yml`: the Effect parser is first-wins (the
    // config layer resolved a.yml) while pflag Sets every occurrence and ends
    // on b.yml — binary-verified: Go POSTs to b.yml's api_url.
    const first = writeProfileYaml("first.yml", "http://first.example");
    const second = writeProfileYaml("second.yml", "http://second.example");
    const restoreEnv = withProfileEnv(undefined);
    const { layer, api } = setup({
      cliArgs: ["sso", "add", "--type", "saml", "--profile", first, "--profile", second],
      profileFlag: first,
    });
    return Effect.gen(function* () {
      yield* legacySsoAdd(defaultFlags);
      const posts = api.requests.filter((r) => r.method === "POST");
      expect(posts.length).toBe(1);
      expect(posts[0]?.url).toBe(
        `http://second.example/v1/projects/${LEGACY_VALID_REF}/config/auth/sso/providers`,
      );
    }).pipe(Effect.ensuring(restoreEnv), Effect.provide(layer));
  });

  it.live(
    "profile emulation: the LoadProfile failure wins over the workdir, required-type, and mutex checks",
    () => {
      // Go loads the profile BEFORE ChangeWorkDir (`cmd/root.go:98-105` —
      // "Load profile before changing workdir"), and both run before
      // `ValidateRequiredFlags` and `ValidateFlagGroups`.
      const restoreEnv = withProfileEnv(undefined);
      const { layer, api } = setup({
        cliArgs: [
          "sso",
          "add",
          "--profile",
          "--metadata-url",
          "https://idp.example.com/m",
          "--metadata-file",
          "a.xml",
          "--workdir",
          "/nonexistent-sso-add-workdir",
        ],
      });
      return Effect.gen(function* () {
        const exit = yield* Effect.exit(
          legacySsoAdd({
            ...defaultFlags,
            metadataUrl: Option.some("https://idp.example.com/m"),
            metadataFile: Option.some("a.xml"),
          }),
        );
        expect(Exit.isFailure(exit)).toBe(true);
        if (Exit.isFailure(exit)) {
          const dump = JSON.stringify(exit.cause);
          expect(dump).toContain("LegacyProfileLoadError");
          expect(dump).not.toContain("LegacyPflagWorkdirError");
          expect(dump).not.toContain("LegacySsoAddRequiredFlagError");
          expect(dump).not.toContain("LegacySsoMutexFlagError");
        }
        expect(api.requests.length).toBe(0);
      }).pipe(Effect.ensuring(restoreEnv), Effect.provide(layer));
    },
  );

  it.live(
    "profile emulation: an agreeing --profile keeps the config layer's resolution (no override)",
    () => {
      // When the scan and the parser saw the same token (every normal
      // invocation), the reconciliation resolves to `none` and the POST
      // targets `LegacyCliConfig.apiUrl` — the layer already loaded exactly
      // the profile Go would.
      const agreed = writeProfileYaml("agreed.yml", "http://agreed.example");
      const restoreEnv = withProfileEnv(undefined);
      const { layer, api } = setup({
        cliArgs: ["sso", "add", "--type", "saml", "--profile", agreed],
        profileFlag: agreed,
      });
      return Effect.gen(function* () {
        yield* legacySsoAdd(defaultFlags);
        const posts = api.requests.filter((r) => r.method === "POST");
        expect(posts.length).toBe(1);
        // The mock layer's apiUrl, NOT agreed.yml's — the layer is authoritative
        // when there is no scan/parser disagreement.
        expect(posts[0]?.url).toBe(
          `${LEGACY_DEFAULT_API_URL}/v1/projects/${LEGACY_VALID_REF}/config/auth/sso/providers`,
        );
      }).pipe(Effect.ensuring(restoreEnv), Effect.provide(layer));
    },
  );
});
