import { writeFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "@effect/vitest";
import { Effect, Exit, Layer, Option, Redacted, Stdio } from "effect";
import * as HttpClientResponse from "effect/unstable/http/HttpClientResponse";

import { mockAnalytics, mockOutput } from "../../../../../tests/helpers/mocks.ts";
import {
  buildLegacyTestRuntime,
  LEGACY_VALID_REF,
  mockLegacyCliConfig,
  mockLegacyLinkedProjectCacheTracked,
  mockLegacyPlatformApi,
  mockLegacyTelemetryStateTracked,
  useLegacyTempWorkdir,
} from "../../../../../tests/helpers/legacy-mocks.ts";
import { LegacyProfileFlag } from "../../../../shared/legacy/global-flags.ts";
import { LegacyIdentityStitch } from "../../../shared/legacy-identity-stitch.ts";
import { EventUpgradeSuggested } from "../../../../shared/telemetry/event-catalog.ts";
import { legacySsoUpdate } from "./update.handler.ts";

const VALID_PROVIDER_ID = "b5ae62f9-ef1d-4f11-a02b-731c8bbb11e8";

const EXISTING_PROVIDER = {
  id: VALID_PROVIDER_ID,
  saml: { id: "saml-1", entity_id: "https://example.com" },
  domains: [
    { id: "d1", domain: "old1.com" },
    { id: "d2", domain: "old2.com" },
  ],
};

const RESPONSE_PROVIDER = {
  id: VALID_PROVIDER_ID,
  saml: { id: "saml-1", entity_id: "https://example.com" },
  domains: [{ id: "d3", domain: "new.com" }],
};

const tempRoot = useLegacyTempWorkdir("supabase-sso-update-int-");

interface SetupOpts {
  format?: "text" | "json" | "stream-json";
  goOutput?: "env" | "pretty" | "json" | "toml" | "yaml";
  getStatus?: number;
  getBody?: unknown;
  /**
   * Serves the provider GET as a raw body + content type instead of
   * `jsonResponse` — for the reconciled-profile raw GET's decode branches
   * (invalid JSON, non-JSON content type).
   */
  getRaw?: { status: number; body: string; contentType: string };
  putStatus?: number;
  putBody?: unknown;
  upgradeGate?: "gated" | "notGated";
  /**
   * Raw argv the handler sees via `Stdio.Stdio` — drives the pflag-faithful
   * scan (`pflagArgvScan`) behind the arity check, the mutex checks, and the
   * value reconciliation. Defaults to a bare invocation with no optional
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
  /**
   * Overrides the config layer's env-shaped access token. `Option.none()`
   * models a machine with no SUPABASE_ACCESS_TOKEN — with a reconciled
   * profile and no keyring/file token, Go's `GetSupabase` gate aborts.
   */
  accessToken?: Option.Option<Redacted.Redacted<string>>;
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

function setup(opts: SetupOpts = {}) {
  const out = mockOutput({ format: opts.format ?? "text" });
  const analytics = mockAnalytics();
  const telemetry = mockLegacyTelemetryStateTracked();
  const cache = mockLegacyLinkedProjectCacheTracked();

  const gate = opts.upgradeGate;
  const getStatus = opts.getStatus ?? 200;
  const getBody = opts.getBody ?? EXISTING_PROVIDER;
  const putStatus = opts.putStatus ?? 200;
  const putBody = opts.putBody ?? RESPONSE_PROVIDER;

  const api = mockLegacyPlatformApi({
    handler: (request) => {
      const url = request.url;
      if (url.includes("/config/auth/sso/providers/")) {
        if (request.method === "GET") {
          if (opts.getRaw !== undefined) {
            return Effect.succeed(
              HttpClientResponse.fromWeb(
                request,
                new Response(opts.getRaw.body, {
                  status: opts.getRaw.status,
                  headers: { "content-type": opts.getRaw.contentType },
                }),
              ),
            );
          }
          return Effect.succeed(jsonResponse(request, getStatus, getBody));
        }
        if (request.method === "PUT")
          return Effect.succeed(jsonResponse(request, putStatus, putBody));
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

  // Tracked identity stitcher: the reconciled-profile raw GET must stitch
  // through the shared per-command guard exactly like the typed client's
  // response transform (Go's identityTransport wraps every response).
  let stitchedResponses = 0;
  const stitchLayer = Layer.succeed(LegacyIdentityStitch, {
    stitch: () =>
      Effect.sync(() => {
        stitchedResponses += 1;
      }),
    stitchedDistinctId: () => undefined,
  });

  const cliConfig = mockLegacyCliConfig({
    workdir: tempRoot.current,
    ...(opts.accessToken !== undefined ? { accessToken: opts.accessToken } : {}),
  });
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
      args: Effect.succeed(opts.cliArgs ?? ["sso", "update", VALID_PROVIDER_ID]),
    }),
    stitchLayer,
    opts.profileFlag === undefined
      ? Layer.empty
      : Layer.succeed(LegacyProfileFlag, opts.profileFlag),
  );

  return {
    layer,
    out,
    api,
    analytics,
    telemetry,
    cache,
    get stitchedResponses() {
      return stitchedResponses;
    },
  };
}

const defaultFlags = {
  projectRef: Option.none<string>(),
  domains: [] as ReadonlyArray<string>,
  addDomains: [] as ReadonlyArray<string>,
  removeDomains: [] as ReadonlyArray<string>,
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
  providerId: VALID_PROVIDER_ID,
};

/**
 * Serializes a flags record into the raw argv the real CLI would have been
 * invoked with. The handler reconciles every value it acts on against a
 * pflag-faithful scan of this argv, so tests must keep the two consistent —
 * a flag passed in the record but absent from argv reconciles to "not set",
 * exactly as it would be for a real invocation.
 */
function cliArgsFor(flags: typeof defaultFlags): ReadonlyArray<string> {
  const argv: string[] = ["sso", "update", flags.providerId];
  if (Option.isSome(flags.projectRef)) {
    argv.push("--project-ref", flags.projectRef.value);
  }
  for (const domain of flags.domains) {
    argv.push("--domains", domain);
  }
  for (const domain of flags.addDomains) {
    argv.push("--add-domains", domain);
  }
  for (const domain of flags.removeDomains) {
    argv.push("--remove-domains", domain);
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

describe("legacy sso update integration", () => {
  it.live("rejects bad UUID", () => {
    const { layer } = setup();
    return Effect.gen(function* () {
      const exit = yield* Effect.exit(
        legacySsoUpdate({ ...defaultFlags, providerId: "not-a-uuid" }),
      );
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        expect(JSON.stringify(exit.cause)).toContain("LegacySsoInvalidUuidError");
      }
    }).pipe(Effect.provide(layer));
  });

  it.live("always GETs before PUTting", () => {
    const { layer, api } = setup();
    return Effect.gen(function* () {
      yield* legacySsoUpdate(defaultFlags);
      const methods = api.requests.map((r) => r.method);
      expect(methods.indexOf("GET")).toBeLessThan(methods.indexOf("PUT"));
    }).pipe(Effect.provide(layer));
  });

  it.live("GET 404 → NotFound error", () => {
    const { layer } = setup({ getStatus: 404, getBody: {} });
    return Effect.gen(function* () {
      const exit = yield* Effect.exit(legacySsoUpdate(defaultFlags));
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        expect(JSON.stringify(exit.cause)).toContain("LegacySsoUpdateNotFoundError");
      }
    }).pipe(Effect.provide(layer));
  });

  it.live("GET 500 → unexpected-status error", () => {
    const { layer } = setup({ getStatus: 500, getBody: { error: "boom" } });
    return Effect.gen(function* () {
      const exit = yield* Effect.exit(legacySsoUpdate(defaultFlags));
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        const dump = JSON.stringify(exit.cause);
        expect(dump).toContain("LegacySsoUpdateUnexpectedStatusError");
        expect(dump).toContain("unexpected error fetching identity provider");
      }
    }).pipe(Effect.provide(layer));
  });

  it.live("mutex check: --domains + --add-domains fails with cobra's exact error text", () => {
    const { layer } = setup({
      cliArgs: ["sso", "update", VALID_PROVIDER_ID, "--domains", "a.com", "--add-domains", "b.com"],
    });
    return Effect.gen(function* () {
      const exit = yield* Effect.exit(
        legacySsoUpdate({ ...defaultFlags, domains: ["a.com"], addDomains: ["b.com"] }),
      );
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        const dump = JSON.stringify(exit.cause);
        expect(dump).toContain("LegacySsoMutexFlagError");
        // Byte-matches cobra's `validateExclusiveFlagGroups` template
        // (`flag_groups.go:204`): group in registration order, changed flags
        // sorted alphabetically — "add-domains" < "domains".
        expect(dump).toContain(
          "if any flags in the group [domains add-domains] are set none of the others can be; [add-domains domains] were all set",
        );
      }
    }).pipe(Effect.provide(layer));
  });

  it.live("mutex check: --domains + --remove-domains fails with cobra's exact error text", () => {
    const { layer } = setup({
      cliArgs: [
        "sso",
        "update",
        VALID_PROVIDER_ID,
        "--domains",
        "a.com",
        "--remove-domains",
        "b.com",
      ],
    });
    return Effect.gen(function* () {
      const exit = yield* Effect.exit(
        legacySsoUpdate({ ...defaultFlags, domains: ["a.com"], removeDomains: ["b.com"] }),
      );
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        const dump = JSON.stringify(exit.cause);
        expect(dump).toContain("LegacySsoMutexFlagError");
        expect(dump).toContain(
          "if any flags in the group [domains remove-domains] are set none of the others can be; [domains remove-domains] were all set",
        );
      }
    }).pipe(Effect.provide(layer));
  });

  it.live(
    "mutex check: an explicit but empty --domains= still conflicts with --add-domains (changed, not truthy)",
    () => {
      // `--domains=` parses to an empty array, but cobra's `pflag.Changed`
      // tracks that the flag was passed at all, not the resulting value — the
      // same "changed vs truthy" gap CLI-1860 fixed for `functions download`'s
      // `--use-docker`. Gating on `.length > 0` would miss this combination.
      const { layer } = setup({
        cliArgs: ["sso", "update", VALID_PROVIDER_ID, "--domains=", "--add-domains", "b.com"],
      });
      return Effect.gen(function* () {
        const exit = yield* Effect.exit(
          legacySsoUpdate({ ...defaultFlags, domains: [], addDomains: ["b.com"] }),
        );
        expect(Exit.isFailure(exit)).toBe(true);
        if (Exit.isFailure(exit)) {
          expect(JSON.stringify(exit.cause)).toContain("LegacySsoMutexFlagError");
        }
      }).pipe(Effect.provide(layer));
    },
  );

  it.live(
    "mutex check: --add-domains and --remove-domains together are not mutually exclusive",
    () => {
      // Go only registers ("domains","add-domains") and ("domains","remove-domains")
      // as separate 2-element groups (`cmd/sso.go:179-180`) — add-domains and
      // remove-domains together, without --domains, is not a violation.
      const { layer } = setup({
        cliArgs: [
          "sso",
          "update",
          VALID_PROVIDER_ID,
          "--add-domains",
          "b.com",
          "--remove-domains",
          "c.com",
        ],
      });
      return Effect.gen(function* () {
        const exit = yield* Effect.exit(
          legacySsoUpdate({ ...defaultFlags, addDomains: ["b.com"], removeDomains: ["c.com"] }),
        );
        expect(Exit.isSuccess(exit)).toBe(true);
      }).pipe(Effect.provide(layer));
    },
  );

  it.live("mutex check: all three domain flags set reports the --add-domains group first", () => {
    // Pins the `SSO_UPDATE_MUTEX_GROUPS` array order: cobra's sorted-key
    // iteration ("domains add-domains" < "domains remove-domains") means the
    // add-domains group is checked — and its error returned — first when all
    // three domain flags collide at once.
    const { layer } = setup({
      cliArgs: [
        "sso",
        "update",
        VALID_PROVIDER_ID,
        "--domains",
        "a.com",
        "--add-domains",
        "b.com",
        "--remove-domains",
        "c.com",
      ],
    });
    return Effect.gen(function* () {
      const exit = yield* Effect.exit(
        legacySsoUpdate({
          ...defaultFlags,
          domains: ["a.com"],
          addDomains: ["b.com"],
          removeDomains: ["c.com"],
        }),
      );
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        const dump = JSON.stringify(exit.cause);
        expect(dump).toContain(
          "if any flags in the group [domains add-domains] are set none of the others can be; [add-domains domains] were all set",
        );
        expect(dump).not.toContain("remove-domains");
      }
    }).pipe(Effect.provide(layer));
  });

  it.live("mutex check: a flag-group violation wins over an invalid provider ID", () => {
    // Cobra runs `ValidateFlagGroups` before `RunE` (`command.go:1010,1014`);
    // Go's provider-ID format check lives inside `RunE` (`cmd/sso.go:90-91`).
    // So an invalid UUID combined with a mutex violation must surface the
    // mutex error, not `LegacySsoInvalidUuidError`.
    const { layer } = setup({
      cliArgs: ["sso", "update", "not-a-uuid", "--domains", "a.com", "--add-domains", "b.com"],
    });
    return Effect.gen(function* () {
      const exit = yield* Effect.exit(
        legacySsoUpdate({
          ...defaultFlags,
          providerId: "not-a-uuid",
          domains: ["a.com"],
          addDomains: ["b.com"],
        }),
      );
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        const dump = JSON.stringify(exit.cause);
        expect(dump).toContain("LegacySsoMutexFlagError");
        expect(dump).not.toContain("LegacySsoInvalidUuidError");
      }
    }).pipe(Effect.provide(layer));
  });

  it.live(
    "mutex check: --metadata-file + --metadata-url fails with cobra's exact error text",
    () => {
      const { layer } = setup({
        cliArgs: [
          "sso",
          "update",
          VALID_PROVIDER_ID,
          "--metadata-file",
          "/tmp/x.xml",
          "--metadata-url",
          "https://idp.example.com/m",
        ],
      });
      return Effect.gen(function* () {
        const exit = yield* Effect.exit(
          legacySsoUpdate({
            ...defaultFlags,
            metadataFile: Option.some("/tmp/x.xml"),
            metadataUrl: Option.some("https://idp.example.com/m"),
          }),
        );
        expect(Exit.isFailure(exit)).toBe(true);
        if (Exit.isFailure(exit)) {
          const dump = JSON.stringify(exit.cause);
          expect(dump).toContain("LegacySsoMutexFlagError");
          // Go registers this pair too (`cmd/sso.go:178`) — it was left emitting
          // a hand-written message alongside the domains groups' custom text
          // before this fix; now all three of `sso update`'s mutex groups on
          // this command share the same byte-exact cobra template.
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
      // value unconditionally (`flag.go:1013-1031`), so real cobra parses this
      // as `metadata-file` receiving the literal value `"--metadata-url"` —
      // `metadata-url` is never parsed as its own flag and stays unset. The
      // TS CLI's own parser (unlike pflag) never hands a dash-prefixed token
      // to a non-boolean flag as a bare value, so here both flags resolve to
      // `Option.none()` — the raw-argv scan must reach the same "not a
      // violation" conclusion pflag does, and the handler must then behave
      // like Go: try to open a file literally named `--metadata-url` instead
      // of silently PUTting with no metadata at all.
      const { layer, api } = setup({
        cliArgs: ["sso", "update", VALID_PROVIDER_ID, "--metadata-file", "--metadata-url"],
      });
      return Effect.gen(function* () {
        const exit = yield* Effect.exit(legacySsoUpdate(defaultFlags));
        expect(Exit.isFailure(exit)).toBe(true);
        if (Exit.isFailure(exit)) {
          const dump = JSON.stringify(exit.cause);
          expect(dump).toContain("LegacySsoUpdateMetadataFileError");
          expect(dump).toContain("failed to open metadata file");
        }
        expect(api.requests.some((r) => r.method === "PUT")).toBe(false);
      }).pipe(Effect.provide(layer));
    },
  );

  it.live(
    "mutex check: a bare --add-domains followed by --domains=... is not a violation, and the consumed token is the domain",
    () => {
      // Same consumed-value class as the metadata-file/metadata-url case
      // above, but for the domains group: pflag hands `add-domains` the
      // literal value `"--domains=x.com"` and never parses `--domains` at
      // all — so Go merges that odd-looking string into the existing domain
      // list and PUTs it. The reconciled handler must produce the same body.
      const { layer, api } = setup({
        cliArgs: ["sso", "update", VALID_PROVIDER_ID, "--add-domains", "--domains=x.com"],
      });
      return Effect.gen(function* () {
        const exit = yield* Effect.exit(legacySsoUpdate(defaultFlags));
        expect(Exit.isSuccess(exit)).toBe(true);
        const putReq = api.requests.find((r) => r.method === "PUT");
        const domains = (putReq?.body as { domains: string[] })?.domains;
        expect([...domains].sort()).toEqual(["--domains=x.com", "old1.com", "old2.com"]);
      }).pipe(Effect.provide(layer));
    },
  );

  it.live(
    "arity emulation: project-ref consuming --metadata-file orphans x.xml — fails ExactArgs like Go, no API calls",
    () => {
      // `<id> --project-ref --metadata-file x.xml --metadata-url u`: pflag
      // hands `--metadata-file` to `--project-ref` as its value, which makes
      // `x.xml` a positional — cobra's `ValidateArgs`/`ExactArgs(1)`
      // (`command.go:968`, `cmd/sso.go:87`) then rejects the arg count
      // before any hook, mutex check, or request. The Effect parser read
      // `--metadata-file x.xml` as a normal flag and saw exactly one
      // positional, so the handler must re-count from the scan (PR #5974
      // review; this refines the earlier ref-validation expectation — Go
      // never even reaches the ref check here).
      const { layer, api } = setup({
        cliArgs: [
          "sso",
          "update",
          VALID_PROVIDER_ID,
          "--project-ref",
          "--metadata-file",
          "x.xml",
          "--metadata-url",
          "https://idp.example.com/m",
        ],
      });
      return Effect.gen(function* () {
        const exit = yield* Effect.exit(
          legacySsoUpdate({
            ...defaultFlags,
            metadataFile: Option.some("x.xml"),
            metadataUrl: Option.some("https://idp.example.com/m"),
          }),
        );
        expect(Exit.isFailure(exit)).toBe(true);
        if (Exit.isFailure(exit)) {
          const dump = JSON.stringify(exit.cause);
          expect(dump).toContain("LegacySsoUpdateArityError");
          expect(dump).toContain("accepts 1 arg(s), received 2");
        }
        expect(api.requests.length).toBe(0);
      }).pipe(Effect.provide(layer));
    },
  );

  it.live(
    "arity emulation: a bare --domains consuming --metadata-url orphans the URL — fails ExactArgs like Go, no GET/PUT",
    () => {
      // `--domains --metadata-url https://… <id>`: pflag consumes
      // `--metadata-url` as the domains value, leaving BOTH the URL and the
      // provider ID positional — Go rejects via `ExactArgs(1)` before any
      // request. The Effect parser instead read the URL as metadata-url's
      // value and saw one positional, so without the re-count the handler
      // would GET and PUT (PR #5974 review, Codex thread).
      const { layer, api } = setup({
        cliArgs: [
          "sso",
          "update",
          "--domains",
          "--metadata-url",
          "https://idp.example.com/m",
          VALID_PROVIDER_ID,
        ],
      });
      return Effect.gen(function* () {
        const exit = yield* Effect.exit(
          legacySsoUpdate({
            ...defaultFlags,
            metadataUrl: Option.some("https://idp.example.com/m"),
          }),
        );
        expect(Exit.isFailure(exit)).toBe(true);
        if (Exit.isFailure(exit)) {
          const dump = JSON.stringify(exit.cause);
          expect(dump).toContain("LegacySsoUpdateArityError");
          expect(dump).toContain("accepts 1 arg(s), received 2");
        }
        expect(api.requests.length).toBe(0);
      }).pipe(Effect.provide(layer));
    },
  );

  it.live(
    "arity emulation: a bare --domains consuming a persistent global flag orphans its value",
    () => {
      // Binary-verified Go behaviour: `--domains --profile staging <id>`
      // arity-errors because pflag hands `--profile` to `--domains` and
      // `staging` becomes positional. The scan must know the root's
      // persistent value flags (`cmd/root.go:324-333`) to see this.
      const { layer, api } = setup({
        cliArgs: ["sso", "update", "--domains", "--profile", "staging", VALID_PROVIDER_ID],
      });
      return Effect.gen(function* () {
        const exit = yield* Effect.exit(legacySsoUpdate(defaultFlags));
        expect(Exit.isFailure(exit)).toBe(true);
        if (Exit.isFailure(exit)) {
          const dump = JSON.stringify(exit.cause);
          expect(dump).toContain("LegacySsoUpdateArityError");
          expect(dump).toContain("accepts 1 arg(s), received 2");
        }
        expect(api.requests.length).toBe(0);
      }).pipe(Effect.provide(layer));
    },
  );

  it.live(
    "arity emulation: persistent global value flags and -o do not miscount positionals",
    () => {
      // Regression guards for the re-count: pflag consumes these globals'
      // values (`--workdir .`, `--output-format json`, `-o json`), so none
      // of them may register as a second positional — each invocation must
      // sail through to the PUT exactly as before.
      const argvVariants: ReadonlyArray<ReadonlyArray<string>> = [
        ["sso", "update", "--workdir", ".", VALID_PROVIDER_ID],
        ["sso", "update", "--output-format", "json", VALID_PROVIDER_ID],
        ["sso", "update", "-o", "json", VALID_PROVIDER_ID],
      ];
      return Effect.gen(function* () {
        for (const cliArgs of argvVariants) {
          const { layer, api } = setup({ cliArgs });
          yield* legacySsoUpdate(defaultFlags).pipe(Effect.provide(layer));
          expect(api.requests.some((r) => r.method === "PUT")).toBe(true);
        }
      });
    },
  );

  it.live("arity emulation: the arity error wins over a mutex violation", () => {
    // cobra's `ValidateArgs` (`command.go:968`) runs before
    // `ValidateFlagGroups` (`command.go:1010`): with `--domains` +
    // `--add-domains` both set AND `--metadata-file` swallowing
    // `--metadata-url` (orphaning `u` as a second positional), Go reports
    // the arg-count error, not the mutex template.
    const { layer, api } = setup({
      cliArgs: [
        "sso",
        "update",
        "--domains",
        "a.com",
        "--add-domains",
        "b.com",
        "--metadata-file",
        "--metadata-url",
        "u",
        VALID_PROVIDER_ID,
      ],
    });
    return Effect.gen(function* () {
      const exit = yield* Effect.exit(
        legacySsoUpdate({
          ...defaultFlags,
          domains: ["a.com"],
          addDomains: ["b.com"],
          metadataUrl: Option.some("u"),
        }),
      );
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        const dump = JSON.stringify(exit.cause);
        expect(dump).toContain("LegacySsoUpdateArityError");
        expect(dump).not.toContain("LegacySsoMutexFlagError");
      }
      expect(api.requests.length).toBe(0);
    }).pipe(Effect.provide(layer));
  });

  it.live(
    "workdir emulation: --workdir consuming a trailing --metadata-file fails at Go's chdir, no GET/PUT",
    () => {
      // `sso update <id> --project-ref <ref> --workdir --metadata-file`:
      // pflag binds `"--metadata-file"` to the persistent `--workdir` (the
      // positional count stays 1) and Go's `ChangeWorkDir`
      // (`cmd/root.go:104`, `misc.go:238-257`) exits before `RunE` with zero
      // HTTP traffic. The Effect parser refused the flag-shaped value and
      // left both flags unset — without the workdir emulation the handler
      // proceeded to GET + PUT (binary-verified, PR #5974 review round 6).
      const { layer, api } = setup({
        cliArgs: [
          "sso",
          "update",
          VALID_PROVIDER_ID,
          "--project-ref",
          LEGACY_VALID_REF,
          "--workdir",
          "--metadata-file",
        ],
      });
      return Effect.gen(function* () {
        const exit = yield* Effect.exit(
          legacySsoUpdate({ ...defaultFlags, projectRef: Option.some(LEGACY_VALID_REF) }),
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
    "workdir emulation: the chdir failure loses to an arity violation but wins over a mutex violation",
    () => {
      // Go's `ChangeWorkDir` runs from `PersistentPreRunE` (`command.go:986`)
      // — after `ValidateArgs` (`command.go:968`), before
      // `ValidateFlagGroups` (`command.go:1010`). Binary-verified: `sso
      // update a b --workdir /missing` reports the arity error, while `sso
      // update <id> --workdir /missing --domains a --add-domains b` reports
      // the chdir failure (PR #5974 review round 6).
      const { layer, api } = setup({
        cliArgs: [
          "sso",
          "update",
          VALID_PROVIDER_ID,
          "--workdir",
          "/nonexistent-sso-update-workdir",
          "--domains",
          "a.com",
          "--add-domains",
          "b.com",
        ],
      });
      return Effect.gen(function* () {
        const exit = yield* Effect.exit(
          legacySsoUpdate({ ...defaultFlags, domains: ["a.com"], addDomains: ["b.com"] }),
        );
        expect(Exit.isFailure(exit)).toBe(true);
        if (Exit.isFailure(exit)) {
          const dump = JSON.stringify(exit.cause);
          expect(dump).toContain("LegacyPflagWorkdirError");
          expect(dump).toContain(
            "failed to change workdir: chdir /nonexistent-sso-update-workdir: no such file or directory",
          );
          expect(dump).not.toContain("LegacySsoMutexFlagError");
        }
        expect(api.requests.length).toBe(0);
      }).pipe(Effect.provide(layer));
    },
  );

  it.live("workdir emulation: the arity error wins over the chdir failure", () => {
    const { layer, api } = setup({
      cliArgs: ["sso", "update", "a", "b", "--workdir", "/nonexistent-sso-update-workdir"],
    });
    return Effect.gen(function* () {
      const exit = yield* Effect.exit(legacySsoUpdate({ ...defaultFlags, providerId: "a" }));
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        const dump = JSON.stringify(exit.cause);
        expect(dump).toContain("LegacySsoUpdateArityError");
        expect(dump).toContain("accepts 1 arg(s), received 2");
        expect(dump).not.toContain("LegacyPflagWorkdirError");
      }
      expect(api.requests.length).toBe(0);
    }).pipe(Effect.provide(layer));
  });

  it.live("arity emulation: the arity error wins over an invalid provider ID", () => {
    // Go's provider-ID format check lives inside `RunE` (`cmd/sso.go:90-91`),
    // long after `ValidateArgs` — a bad UUID must not mask the arg-count
    // error.
    const { layer, api } = setup({
      cliArgs: ["sso", "update", "--domains", "--metadata-url", "u", "not-a-uuid"],
    });
    return Effect.gen(function* () {
      const exit = yield* Effect.exit(
        legacySsoUpdate({
          ...defaultFlags,
          providerId: "not-a-uuid",
          metadataUrl: Option.some("u"),
        }),
      );
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        const dump = JSON.stringify(exit.cause);
        expect(dump).toContain("LegacySsoUpdateArityError");
        expect(dump).not.toContain("LegacySsoInvalidUuidError");
      }
      expect(api.requests.length).toBe(0);
    }).pipe(Effect.provide(layer));
  });

  it.live(
    "arity emulation: a consumed boolean global keeps the count at 1 and PUTs, like Go",
    () => {
      // `--domains --yes <id>`: pflag hands `--yes` to `--domains` (a
      // consumed token is a value no matter what it looks like), so only the
      // provider ID stays positional — Go proceeds and PUTs
      // `domains: ["--yes"]` (binary-verified). The re-count must not turn
      // this into an arity error.
      const { layer, api } = setup({
        cliArgs: ["sso", "update", "--domains", "--yes", VALID_PROVIDER_ID],
      });
      return Effect.gen(function* () {
        yield* legacySsoUpdate(defaultFlags);
        const putReq = api.requests.find((r) => r.method === "PUT");
        expect((putReq?.body as { domains?: string[] })?.domains).toEqual(["--yes"]);
      }).pipe(Effect.provide(layer));
    },
  );

  it.live(
    "missing-value emulation: a trailing bare --domains fails pflag parse, no GET/PUT",
    () => {
      // Binary-verified: `sso update <id> --domains` errors
      // `flag needs an argument: --domains` — pflag fails `ParseFlags`
      // (cobra `command.go:919`) before `ValidateArgs`, every hook, and
      // `RunE`, so Go makes no API call. The Effect parser accepts the argv
      // (the flag parses as unset), so without this check the handler would
      // GET and PUT with an empty domain list (PR #5974 review round 3).
      const { layer, api } = setup({
        cliArgs: ["sso", "update", VALID_PROVIDER_ID, "--domains"],
      });
      return Effect.gen(function* () {
        const exit = yield* Effect.exit(legacySsoUpdate(defaultFlags));
        expect(Exit.isFailure(exit)).toBe(true);
        if (Exit.isFailure(exit)) {
          const dump = JSON.stringify(exit.cause);
          expect(dump).toContain("LegacySsoFlagNeedsArgumentError");
          expect(dump).toContain("flag needs an argument: --domains");
        }
        expect(api.requests.length).toBe(0);
      }).pipe(Effect.provide(layer));
    },
  );

  it.live("missing-value emulation: the pflag parse error wins over an arity violation", () => {
    // pflag fails parsing (`command.go:919`) before cobra's `ValidateArgs`
    // (`command.go:968`), so when `--domains` swallows `--metadata-url`
    // (orphaning `u` as a second positional) AND `--add-domains` trails
    // bare, Go reports the missing argument, not the arg count
    // (binary-verified: `sso update a b --domains`).
    const { layer, api } = setup({
      cliArgs: [
        "sso",
        "update",
        "--domains",
        "--metadata-url",
        "https://idp.example.com/m",
        VALID_PROVIDER_ID,
        "--add-domains",
      ],
    });
    return Effect.gen(function* () {
      const exit = yield* Effect.exit(
        legacySsoUpdate({
          ...defaultFlags,
          metadataUrl: Option.some("https://idp.example.com/m"),
        }),
      );
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        const dump = JSON.stringify(exit.cause);
        expect(dump).toContain("LegacySsoFlagNeedsArgumentError");
        expect(dump).toContain("flag needs an argument: --add-domains");
        expect(dump).not.toContain("LegacySsoUpdateArityError");
      }
      expect(api.requests.length).toBe(0);
    }).pipe(Effect.provide(layer));
  });

  it.live(
    "anchoring: a persistent flag between sso and update still enforces arity, like Go",
    () => {
      // Binary-verified: `sso --profile foo update --domains --metadata-url
      // u <id>` errors `accepts 1 arg(s), received 2` — cobra routes through
      // the interspersed persistent flag (`Find`/`stripFlags`) and pflag
      // still hands `--metadata-url` to `--domains`. The scan must anchor
      // across the interspersed flag or the arity re-count silently
      // vanishes and the handler GETs/PUTs (PR #5974 review round 3).
      const { layer, api } = setup({
        cliArgs: [
          "sso",
          "--profile",
          "supabase",
          "update",
          "--domains",
          "--metadata-url",
          "https://idp.example.com/m",
          VALID_PROVIDER_ID,
        ],
      });
      return Effect.gen(function* () {
        const exit = yield* Effect.exit(
          legacySsoUpdate({
            ...defaultFlags,
            metadataUrl: Option.some("https://idp.example.com/m"),
          }),
        );
        expect(Exit.isFailure(exit)).toBe(true);
        if (Exit.isFailure(exit)) {
          const dump = JSON.stringify(exit.cause);
          expect(dump).toContain("LegacySsoUpdateArityError");
          expect(dump).toContain("accepts 1 arg(s), received 2");
        }
        expect(api.requests.length).toBe(0);
      }).pipe(Effect.provide(layer));
    },
  );

  it.live("anchoring: a persistent flag between sso and update sails through to the PUT", () => {
    // Regression guard for the anchor walk: a well-formed interspersed
    // invocation (`sso --profile supabase update <id>`) must behave exactly
    // like the contiguous one.
    const { layer, api } = setup({
      cliArgs: ["sso", "--profile", "supabase", "update", VALID_PROVIDER_ID],
    });
    return Effect.gen(function* () {
      yield* legacySsoUpdate(defaultFlags);
      expect(api.requests.some((r) => r.method === "PUT")).toBe(true);
    }).pipe(Effect.provide(layer));
  });

  it.live(
    "value reconciliation: repeated --skip-url-validation resolves last-wins like pflag (=false then bare ends true, skips validation, PUTs)",
    () => {
      // `--skip-url-validation=false --skip-url-validation --metadata-url
      // http://…`: pflag Sets every occurrence in order, ending true, so Go
      // skips URL validation and PUTs. The Effect parser resolves repeats
      // first-wins (false) and would have validated — and rejected — the
      // non-HTTPS URL (PR #5974 review round 4, binary-verified).
      const { layer, api } = setup({
        cliArgs: [
          "sso",
          "update",
          VALID_PROVIDER_ID,
          "--skip-url-validation=false",
          "--skip-url-validation",
          "--metadata-url",
          "http://insecure.example.com/md",
        ],
      });
      return Effect.gen(function* () {
        yield* legacySsoUpdate({
          ...defaultFlags,
          skipUrlValidation: false, // Effect's first-wins parse
          metadataUrl: Option.some("http://insecure.example.com/md"),
        });
        const putReq = api.requests.find((r) => r.method === "PUT");
        expect((putReq?.body as { metadata_url?: string })?.metadata_url).toBe(
          "http://insecure.example.com/md",
        );
      }).pipe(Effect.provide(layer));
    },
  );

  it.live(
    "value reconciliation: bare then =false ends false like pflag — URL validation runs and rejects, no PUT",
    () => {
      // The mirror case: `--skip-url-validation --skip-url-validation=false`
      // is false to pflag (last-wins) but true to the Effect parser
      // (first-wins), so without reconciliation the handler would skip the
      // validation Go performs and PUT an unvalidated URL.
      const { layer, api } = setup({
        cliArgs: [
          "sso",
          "update",
          VALID_PROVIDER_ID,
          "--skip-url-validation",
          "--skip-url-validation=false",
          "--metadata-url",
          "http://insecure.example.com/md",
        ],
      });
      return Effect.gen(function* () {
        const exit = yield* Effect.exit(
          legacySsoUpdate({
            ...defaultFlags,
            skipUrlValidation: true, // Effect's first-wins parse
            metadataUrl: Option.some("http://insecure.example.com/md"),
          }),
        );
        expect(Exit.isFailure(exit)).toBe(true);
        if (Exit.isFailure(exit)) {
          const dump = JSON.stringify(exit.cause);
          expect(dump).toContain("LegacySsoUpdateMetadataFileError");
          expect(dump).toContain("only HTTPS Metadata URLs are supported");
        }
        // Go GETs first (`update.go:42`), then fails validation before the PUT.
        expect(api.requests.some((r) => r.method === "PUT")).toBe(false);
      }).pipe(Effect.provide(layer));
    },
  );

  it.live(
    "value reconciliation: --domains consuming one --name-id-format leaves the other as pflag's effective value in the PUT",
    () => {
      // `--domains --name-id-format=T --name-id-format P`: pflag hands the
      // first name-id-format token to `--domains` as its value, so the only
      // occurrence it Sets is P. The Effect parser read both and resolved
      // first-wins to T — the PUT body must carry P, exactly what the Go
      // binary sends (PR #5974 review round 4).
      const transient = "urn:oasis:names:tc:SAML:2.0:nameid-format:transient" as const;
      const persistent = "urn:oasis:names:tc:SAML:2.0:nameid-format:persistent";
      const { layer, api } = setup({
        cliArgs: [
          "sso",
          "update",
          VALID_PROVIDER_ID,
          "--skip-url-validation",
          "--domains",
          `--name-id-format=${transient}`,
          "--name-id-format",
          persistent,
          "--metadata-url",
          "http://insecure.example.com/md",
        ],
      });
      return Effect.gen(function* () {
        yield* legacySsoUpdate({
          ...defaultFlags,
          skipUrlValidation: true,
          nameIdFormat: Option.some(transient), // Effect's first-wins parse
          metadataUrl: Option.some("http://insecure.example.com/md"),
        });
        const putReq = api.requests.find((r) => r.method === "PUT");
        const body = putReq?.body as { name_id_format?: string; domains?: string[] };
        expect(body?.name_id_format).toBe(persistent);
        // The consumed token is pflag's literal domains value.
        expect(body?.domains).toEqual([`--name-id-format=${transient}`]);
      }).pipe(Effect.provide(layer));
    },
  );

  it.live(
    "invalid-value emulation: --skip-url-validation=yes fails with pflag's strconv.ParseBool error, no API calls",
    () => {
      // The Effect parser accepts `yes`; Go's strconv.ParseBool does not —
      // pflag fails ParseFlags (cobra `command.go:919`) before every hook
      // and request (binary-verified, PR #5974 review round 4).
      const { layer, api } = setup({
        cliArgs: [
          "sso",
          "update",
          VALID_PROVIDER_ID,
          "--skip-url-validation=yes",
          "--metadata-url",
          "https://idp.example.com/m",
        ],
      });
      return Effect.gen(function* () {
        const exit = yield* Effect.exit(
          legacySsoUpdate({
            ...defaultFlags,
            skipUrlValidation: true, // the Effect parser reads yes as true
            metadataUrl: Option.some("https://idp.example.com/m"),
          }),
        );
        expect(Exit.isFailure(exit)).toBe(true);
        if (Exit.isFailure(exit)) {
          const dump = JSON.stringify(exit.cause);
          expect(dump).toContain("LegacySsoInvalidFlagValueError");
          expect(dump).toContain(
            'invalid argument \\"yes\\" for \\"--skip-url-validation\\" flag: strconv.ParseBool: parsing \\"yes\\": invalid syntax',
          );
        }
        expect(api.requests.length).toBe(0);
      }).pipe(Effect.provide(layer));
    },
  );

  it.live(
    "invalid-value emulation: a later inline-empty --skip-url-validation= fails like pflag, no API calls",
    () => {
      // `--skip-url-validation=false --skip-url-validation=`: the Effect
      // parser resolves repeats first-wins and never validates the second
      // occurrence, so it parses; pflag hands `""` to strconv.ParseBool
      // (`flag.go:1014-1016`) and aborts ParseFlags before every hook and
      // any GET/PUT — only a *bare* repeat means NoOptDefVal true
      // (binary-verified, PR #5974 review round 5).
      const { layer, api } = setup({
        cliArgs: [
          "sso",
          "update",
          VALID_PROVIDER_ID,
          "--skip-url-validation=false",
          "--skip-url-validation=",
          "--metadata-url",
          "https://idp.example.com/m",
        ],
      });
      return Effect.gen(function* () {
        const exit = yield* Effect.exit(
          legacySsoUpdate({
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
    "invalid-value emulation: a later invalid --name-id-format occurrence fails like pflag, no API calls",
    () => {
      // The Effect parser resolves repeats first-wins and never validates
      // the rest, so `--name-id-format=<valid> --name-id-format=bogus`
      // parses; pflag Sets every occurrence and aborts on `bogus`
      // (binary-verified, PR #5974 review round 4).
      const persistent = "urn:oasis:names:tc:SAML:2.0:nameid-format:persistent" as const;
      const { layer, api } = setup({
        cliArgs: [
          "sso",
          "update",
          VALID_PROVIDER_ID,
          `--name-id-format=${persistent}`,
          "--name-id-format=bogus",
        ],
      });
      return Effect.gen(function* () {
        const exit = yield* Effect.exit(
          legacySsoUpdate({
            ...defaultFlags,
            nameIdFormat: Option.some(persistent), // Effect's first-wins parse
          }),
        );
        expect(Exit.isFailure(exit)).toBe(true);
        if (Exit.isFailure(exit)) {
          const dump = JSON.stringify(exit.cause);
          expect(dump).toContain("LegacySsoInvalidFlagValueError");
          expect(dump).toContain(
            'invalid argument \\"bogus\\" for \\"--name-id-format\\" flag: must be one of [ urn:oasis',
          );
          expect(dump).toContain("nameid-format:transient ]");
        }
        expect(api.requests.length).toBe(0);
      }).pipe(Effect.provide(layer));
    },
  );

  it.live(
    "invalid-value emulation: an invalid occurrence beats a trailing missing value, matching pflag's sequential walk",
    () => {
      // `--skip-url-validation=yes --domains`: pflag walks argv in order and
      // rejects `yes` before ever reaching the bare trailing `--domains`
      // (binary-verified: Go names the invalid argument, not the missing one).
      const { layer, api } = setup({
        cliArgs: ["sso", "update", VALID_PROVIDER_ID, "--skip-url-validation=yes", "--domains"],
      });
      return Effect.gen(function* () {
        const exit = yield* Effect.exit(
          legacySsoUpdate({ ...defaultFlags, skipUrlValidation: true }),
        );
        expect(Exit.isFailure(exit)).toBe(true);
        if (Exit.isFailure(exit)) {
          const dump = JSON.stringify(exit.cause);
          expect(dump).toContain("LegacySsoInvalidFlagValueError");
          expect(dump).not.toContain("LegacySsoFlagNeedsArgumentError");
        }
        expect(api.requests.length).toBe(0);
      }).pipe(Effect.provide(layer));
    },
  );

  it.live("--domains replaces domains verbatim", () => {
    const flags = { ...defaultFlags, domains: ["new.com"] };
    const { layer, api } = setup({ cliArgs: cliArgsFor(flags) });
    return Effect.gen(function* () {
      yield* legacySsoUpdate(flags);
      const putReq = api.requests.find((r) => r.method === "PUT");
      expect((putReq?.body as { domains?: string[] })?.domains).toEqual(["new.com"]);
    }).pipe(Effect.provide(layer));
  });

  it.live("--add-domains merges with existing GET domains", () => {
    const flags = { ...defaultFlags, addDomains: ["new.com"] };
    const { layer, api } = setup({ cliArgs: cliArgsFor(flags) });
    return Effect.gen(function* () {
      yield* legacySsoUpdate(flags);
      const putReq = api.requests.find((r) => r.method === "PUT");
      const domains = (putReq?.body as { domains: string[] })?.domains;
      // Go map iteration is unordered — sort before asserting.
      expect([...domains].sort()).toEqual(["new.com", "old1.com", "old2.com"]);
    }).pipe(Effect.provide(layer));
  });

  it.live("--remove-domains strips from existing GET domains", () => {
    const flags = { ...defaultFlags, removeDomains: ["old1.com"] };
    const { layer, api } = setup({ cliArgs: cliArgsFor(flags) });
    return Effect.gen(function* () {
      yield* legacySsoUpdate(flags);
      const putReq = api.requests.find((r) => r.method === "PUT");
      const domains = (putReq?.body as { domains: string[] })?.domains;
      expect([...domains].sort()).toEqual(["old2.com"]);
    }).pipe(Effect.provide(layer));
  });

  it.live("no domain flag set → PUT still sends the recomputed existing domain set", () => {
    // Go's `--add-domains`/`--remove-domains` default to a non-nil `[]string{}`
    // (`cmd/sso.go:171-172`), so `update.go:84`'s `!= nil` gate is always true
    // from the CLI — every `sso update` enters the merge and sends `domains`,
    // even when no domain flag was passed (CLI-1981). Live-captured Go PUT:
    // `{"domains":["old1.com","old2.com"]}`.
    const { layer, api } = setup();
    return Effect.gen(function* () {
      yield* legacySsoUpdate(defaultFlags);
      const putReq = api.requests.find((r) => r.method === "PUT");
      const domains = (putReq?.body as { domains: string[] })?.domains;
      // Go map iteration is unordered — sort before asserting.
      expect([...domains].sort()).toEqual(["old1.com", "old2.com"]);
    }).pipe(Effect.provide(layer));
  });

  it.live(
    "no domain flags + provider with no domains → PUT sends domains: [] (not omitted)",
    () => {
      // Go sets `body.Domains` to a non-nil pointer to `make([]string, 0)`, and
      // `json:"domains,omitempty"` never omits a non-nil pointer — live-captured
      // Go PUT body is exactly `{"domains":[]}`.
      const { layer, api } = setup({ getBody: { ...EXISTING_PROVIDER, domains: [] } });
      return Effect.gen(function* () {
        yield* legacySsoUpdate(defaultFlags);
        const putReq = api.requests.find((r) => r.method === "PUT");
        const body = putReq?.body as Record<string, unknown>;
        expect(Object.keys(body)).toContain("domains");
        expect(body["domains"]).toEqual([]);
      }).pipe(Effect.provide(layer));
    },
  );

  it.live("no domain flags + GET response missing domains entirely → PUT sends domains: []", () => {
    // Go's seed loop is skipped when `getResp.JSON200.Domains == nil`, leaving
    // the merged set empty — same `{"domains":[]}` bytes as the empty-list case.
    const { domains: _omitted, ...providerWithoutDomains } = EXISTING_PROVIDER;
    const { layer, api } = setup({ getBody: providerWithoutDomains });
    return Effect.gen(function* () {
      yield* legacySsoUpdate(defaultFlags);
      const putReq = api.requests.find((r) => r.method === "PUT");
      const body = putReq?.body as Record<string, unknown>;
      expect(Object.keys(body)).toContain("domains");
      expect(body["domains"]).toEqual([]);
    }).pipe(Effect.provide(layer));
  });

  it.live("explicit empty --domains= falls into the merge and resends the existing set", () => {
    // `--domains=` parses to an empty slice, so Go's `len(params.Domains) != 0`
    // replace gate is false and the merge branch runs with no add/remove —
    // live-captured Go PUT resends the existing domains, it does NOT replace
    // them with an empty list.
    const { layer, api } = setup({
      cliArgs: ["sso", "update", VALID_PROVIDER_ID, "--domains="],
    });
    return Effect.gen(function* () {
      yield* legacySsoUpdate({ ...defaultFlags, domains: [] });
      const putReq = api.requests.find((r) => r.method === "PUT");
      const domains = (putReq?.body as { domains: string[] })?.domains;
      expect([...domains].sort()).toEqual(["old1.com", "old2.com"]);
    }).pipe(Effect.provide(layer));
  });

  it.live("merge keeps empty-string domains and skips entries without a domain field", () => {
    // Go's seed check is nil-ness only (`domain.Domain != nil`,
    // `update.go:89`): an empty-string domain from the GET response stays in
    // the merged set, while an entry missing the field entirely is skipped.
    const { layer, api } = setup({
      getBody: {
        ...EXISTING_PROVIDER,
        domains: [{ id: "d1", domain: "" }, { id: "d2", domain: "old1.com" }, { id: "d3" }],
      },
    });
    return Effect.gen(function* () {
      yield* legacySsoUpdate(defaultFlags);
      const putReq = api.requests.find((r) => r.method === "PUT");
      const domains = (putReq?.body as { domains: string[] })?.domains;
      expect([...domains].sort()).toEqual(["", "old1.com"]);
    }).pipe(Effect.provide(layer));
  });

  it.live("reads metadata file and sends as metadata_xml on PUT", () => {
    const path = join(tempRoot.current, "good.xml");
    writeFileSync(path, '<?xml version="1.0"?><md/>');
    const flags = { ...defaultFlags, metadataFile: Option.some(path) };
    const { layer, api } = setup({ cliArgs: cliArgsFor(flags) });
    return Effect.gen(function* () {
      yield* legacySsoUpdate(flags);
      const putReq = api.requests.find((r) => r.method === "PUT");
      expect((putReq?.body as { metadata_xml?: string })?.metadata_xml).toContain("<md/>");
    }).pipe(Effect.provide(layer));
  });

  it.live("preserves attribute_mapping `default` field in PUT body", () => {
    const path = join(tempRoot.current, "map.json");
    writeFileSync(path, JSON.stringify({ keys: { a: { default: 3 } } }));
    const flags = { ...defaultFlags, attributeMappingFile: Option.some(path) };
    const { layer, api } = setup({ cliArgs: cliArgsFor(flags) });
    return Effect.gen(function* () {
      yield* legacySsoUpdate(flags);
      const putReq = api.requests.find((r) => r.method === "PUT");
      const mapping = (putReq?.body as { attribute_mapping?: { keys: { a: { default: number } } } })
        ?.attribute_mapping;
      expect(mapping?.keys.a.default).toBe(3);
    }).pipe(Effect.provide(layer));
  });

  it.live("PUT 200 → renders single-provider markdown in text mode", () => {
    const { layer, out } = setup();
    return Effect.gen(function* () {
      yield* legacySsoUpdate(defaultFlags);
      expect(out.stdoutText).toContain(VALID_PROVIDER_ID);
    }).pipe(Effect.provide(layer));
  });

  it.live("PUT 4xx + gated entitlement → unexpected error + cli_upgrade_suggested", () => {
    // legacySuggestUpgrade fires only on 4xx (matches Go's `plan_gate.go:29`).
    const { layer, analytics } = setup({
      putStatus: 403,
      putBody: { error: "forbidden" },
      upgradeGate: "gated",
    });
    return Effect.gen(function* () {
      const exit = yield* Effect.exit(legacySsoUpdate(defaultFlags));
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        expect(JSON.stringify(exit.cause)).toContain("LegacySsoUpdateUnexpectedStatusError");
      }
      expect(analytics.captured.some((c) => c.event === EventUpgradeSuggested)).toBe(true);
    }).pipe(Effect.provide(layer));
  });

  it.live("Go --output=env emits nothing", () => {
    const { layer, out } = setup({ goOutput: "env" });
    return Effect.gen(function* () {
      yield* legacySsoUpdate(defaultFlags);
      expect(out.stdoutText).toBe("");
    }).pipe(Effect.provide(layer));
  });

  it.live("Go --output=json encodes response verbatim", () => {
    const { layer, out } = setup({ goOutput: "json" });
    return Effect.gen(function* () {
      yield* legacySsoUpdate(defaultFlags);
      expect(out.stdoutText).toContain(VALID_PROVIDER_ID);
    }).pipe(Effect.provide(layer));
  });

  it.live("TS --output-format=json emits success", () => {
    const { layer, out } = setup({ format: "json" });
    return Effect.gen(function* () {
      yield* legacySsoUpdate(defaultFlags);
      expect(out.messages.some((m) => m.type === "success")).toBe(true);
    }).pipe(Effect.provide(layer));
  });

  it.live("flushes telemetry even on GET failure", () => {
    const { layer, telemetry } = setup({ getStatus: 500, getBody: {} });
    return Effect.gen(function* () {
      yield* Effect.exit(legacySsoUpdate(defaultFlags));
      expect(telemetry.flushed).toBe(true);
    }).pipe(Effect.provide(layer));
  });

  it.live("Go --output=yaml encodes response verbatim", () => {
    const { layer, out } = setup({ goOutput: "yaml" });
    return Effect.gen(function* () {
      yield* legacySsoUpdate(defaultFlags);
      expect(out.stdoutText).toContain(VALID_PROVIDER_ID);
    }).pipe(Effect.provide(layer));
  });

  it.live("Go --output=toml encodes response verbatim", () => {
    const { layer, out } = setup({ goOutput: "toml" });
    return Effect.gen(function* () {
      yield* legacySsoUpdate(defaultFlags);
      expect(out.stdoutText).toContain(VALID_PROVIDER_ID);
    }).pipe(Effect.provide(layer));
  });

  it.live("nameIdFormat is forwarded in PUT body when provided", () => {
    const flags = {
      ...defaultFlags,
      nameIdFormat: Option.some("urn:oasis:names:tc:SAML:2.0:nameid-format:persistent" as const),
    };
    const { layer, api } = setup({ cliArgs: cliArgsFor(flags) });
    return Effect.gen(function* () {
      yield* legacySsoUpdate(flags);
      const putReq = api.requests.find((r) => r.method === "PUT");
      expect((putReq?.body as { name_id_format?: string })?.name_id_format).toBe(
        "urn:oasis:names:tc:SAML:2.0:nameid-format:persistent",
      );
    }).pipe(Effect.provide(layer));
  });

  it.live("malformed metadata URL surfaces as update metadata file error", () => {
    const flags = {
      ...defaultFlags,
      metadataUrl: Option.some("::::not a url::::"),
      skipUrlValidation: false,
    };
    const { layer } = setup({ cliArgs: cliArgsFor(flags) });
    return Effect.gen(function* () {
      const exit = yield* Effect.exit(legacySsoUpdate(flags));
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        const dump = JSON.stringify(exit.cause);
        expect(dump).toContain("LegacySsoUpdateMetadataFileError");
        // Per Go's `update.go:69`: error tail is `… Use --skip-url-validation to suppress this error.`
        // (trailing period).
        expect(dump).toContain("Use --skip-url-validation to suppress this error.");
      }
    }).pipe(Effect.provide(layer));
  });

  it.live("malformed attribute-mapping JSON surfaces a tagged error", () => {
    const path = join(tempRoot.current, "malformed.json");
    writeFileSync(path, "{not json}");
    const flags = { ...defaultFlags, attributeMappingFile: Option.some(path) };
    const { layer } = setup({ cliArgs: cliArgsFor(flags) });
    return Effect.gen(function* () {
      const exit = yield* Effect.exit(legacySsoUpdate(flags));
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        expect(JSON.stringify(exit.cause)).toContain("LegacySsoUpdateAttributeMappingFileError");
      }
    }).pipe(Effect.provide(layer));
  });

  it.live("--add-domains + --remove-domains combined apply remove then add", () => {
    const flags = { ...defaultFlags, addDomains: ["new.com"], removeDomains: ["old1.com"] };
    const { layer, api } = setup({ cliArgs: cliArgsFor(flags) });
    return Effect.gen(function* () {
      yield* legacySsoUpdate(flags);
      const putReq = api.requests.find((r) => r.method === "PUT");
      const domains = (putReq?.body as { domains: string[] })?.domains;
      // Go uses map iteration → unordered; sort before asserting.
      expect([...domains].sort()).toEqual(["new.com", "old2.com"]);
    }).pipe(Effect.provide(layer));
  });

  // -------------------------------------------------------------------------
  // Profile emulation (PR #5974 review round 7): Go's `LoadProfile` runs from
  // the root `PersistentPreRunE` (`cmd/root.go:98-102`) on the pflag/viper-
  // effective `--profile`/`SUPABASE_PROFILE`, immediately before
  // `ChangeWorkDir` — it decides which API host receives the GET *and* the
  // PUT (Go targets the same host for both, `update.go:42`), and aborts the
  // command when the profile cannot be loaded.
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
    "profile emulation: repeated --profile resolves last-wins — GET and PUT both target the last file's host",
    () => {
      // `sso update <id> --profile first.yml --profile second.yml`: the
      // Effect parser is first-wins (the config layer — and the typed client
      // — resolved first.yml) while pflag Sets every occurrence and ends on
      // second.yml. Go GETs and PUTs second.yml's api_url (`update.go:42`);
      // first.yml's host receives nothing.
      const first = writeProfileYaml("first.yml", "http://first.example");
      const second = writeProfileYaml("second.yml", "http://second.example");
      const restoreEnv = withProfileEnv(undefined);
      const testSetup = setup({
        cliArgs: ["sso", "update", VALID_PROVIDER_ID, "--profile", first, "--profile", second],
        profileFlag: first,
      });
      const { layer, api, cache } = testSetup;
      return Effect.gen(function* () {
        yield* legacySsoUpdate(defaultFlags);
        const providerUrl = `http://second.example/v1/projects/${LEGACY_VALID_REF}/config/auth/sso/providers/${VALID_PROVIDER_ID}`;
        const get = api.requests.find((r) => r.method === "GET");
        const put = api.requests.find((r) => r.method === "PUT");
        expect(get?.url).toBe(providerUrl);
        expect(put?.url).toBe(providerUrl);
        // The merge seeds from the reconciled host's GET response.
        const domains = (put?.body as { domains?: string[] })?.domains ?? [];
        expect([...domains].sort()).toEqual(["old1.com", "old2.com"]);
        expect(api.requests.some((r) => r.url.startsWith("http://first.example"))).toBe(false);
        // The raw GET stitches identity through the shared per-command guard,
        // like Go's identityTransport on every Management API response.
        expect(testSetup.stitchedResponses).toBeGreaterThan(0);
        // The linked-project cache fill targets the reconciled host too
        // (Go's ensureProjectGroupsCached uses the process-wide profile).
        expect(cache.cachedApiUrl).toBe("http://second.example");
      }).pipe(Effect.ensuring(restoreEnv), Effect.provide(layer));
    },
  );

  it.live(
    "profile emulation: the reconciled-host GET maps a 404 exactly like the typed client",
    () => {
      const first = writeProfileYaml("first-404.yml", "http://first.example");
      const second = writeProfileYaml("second-404.yml", "http://second.example");
      const restoreEnv = withProfileEnv(undefined);
      const { layer, api } = setup({
        getStatus: 404,
        getBody: {},
        cliArgs: ["sso", "update", VALID_PROVIDER_ID, "--profile", first, "--profile", second],
        profileFlag: first,
      });
      return Effect.gen(function* () {
        const exit = yield* Effect.exit(legacySsoUpdate(defaultFlags));
        expect(Exit.isFailure(exit)).toBe(true);
        if (Exit.isFailure(exit)) {
          const dump = JSON.stringify(exit.cause);
          expect(dump).toContain("LegacySsoUpdateNotFoundError");
          expect(dump).toContain(
            `An identity provider with ID \\"${VALID_PROVIDER_ID}\\" could not be found.`,
          );
        }
        expect(api.requests.some((r) => r.method === "PUT")).toBe(false);
      }).pipe(Effect.ensuring(restoreEnv), Effect.provide(layer));
    },
  );

  it.live(
    "profile emulation: the reconciled-host GET maps a non-404 status exactly like the typed client",
    () => {
      const first = writeProfileYaml("first-500.yml", "http://first.example");
      const second = writeProfileYaml("second-500.yml", "http://second.example");
      const restoreEnv = withProfileEnv(undefined);
      const { layer, api } = setup({
        getStatus: 500,
        getBody: { error: "boom" },
        cliArgs: ["sso", "update", VALID_PROVIDER_ID, "--profile", first, "--profile", second],
        profileFlag: first,
      });
      return Effect.gen(function* () {
        const exit = yield* Effect.exit(legacySsoUpdate(defaultFlags));
        expect(Exit.isFailure(exit)).toBe(true);
        if (Exit.isFailure(exit)) {
          const dump = JSON.stringify(exit.cause);
          expect(dump).toContain("LegacySsoUpdateUnexpectedStatusError");
          expect(dump).toContain("unexpected error fetching identity provider:");
        }
        expect(api.requests.some((r) => r.method === "PUT")).toBe(false);
      }).pipe(Effect.ensuring(restoreEnv), Effect.provide(layer));
    },
  );

  it.live(
    "profile emulation: the reconciled GET narrows odd JSON shapes when merging domains",
    () => {
      // Covers the raw GET's JSON-narrowing fallbacks: a `domains` entry
      // that isn't an object and one whose `domain` isn't a string are
      // skipped, matching the typed client's schema behavior.
      const first = writeProfileYaml("first-merge.yml", "http://first.example");
      const second = writeProfileYaml("second-merge.yml", "http://second.example");
      const restoreEnv = withProfileEnv(undefined);
      const { layer, api, cache } = setup({
        getBody: {
          id: VALID_PROVIDER_ID,
          domains: [{ domain: "old1.com" }, "not-an-object", { domain: 42 }],
        },
        cliArgs: [
          "sso",
          "update",
          VALID_PROVIDER_ID,
          "--add-domains",
          "new.com",
          "--profile",
          first,
          "--profile",
          second,
        ],
        profileFlag: first,
      });
      return Effect.gen(function* () {
        yield* legacySsoUpdate({ ...defaultFlags, addDomains: ["new.com"] });
        const put = api.requests.find((r) => r.method === "PUT");
        expect(put?.url).toBe(
          `http://second.example/v1/projects/${LEGACY_VALID_REF}/config/auth/sso/providers/${VALID_PROVIDER_ID}`,
        );
        const domains = (put?.body as { domains?: string[] })?.domains ?? [];
        expect([...domains].sort()).toEqual(["new.com", "old1.com"]);
        // The linked-project cache fill receives the RECONCILED profile's
        // token explicitly (here the profile-independent env token) — the
        // stale profile's keyring token must never follow the reconciled URL
        // (review r3684524241). `undefined` would fall back to the config
        // layer's credentials service.
        expect(cache.cachedAccessToken).toBeDefined();
      }).pipe(Effect.ensuring(restoreEnv), Effect.provide(layer));
    },
  );

  it.live("profile emulation: a reconciled profile with no resolvable token aborts like Go", () => {
    // Go's `GetSupabase` gate (`api.go:119-124`) `log.Fatalln`s ErrMissingToken
    // at first client use when the RECONCILED profile's lookup finds nothing —
    // the stale profile's token must never be substituted, and no request may
    // be issued (PR #5974 review round 10, r3686720488).
    const first = writeProfileYaml("first-notoken.yml", "http://first.example");
    const second = writeProfileYaml("second-notoken.yml", "http://second.example");
    const restoreEnv = withProfileEnv(undefined);
    const { layer, api } = setup({
      accessToken: Option.none(),
      cliArgs: [
        "sso",
        "update",
        VALID_PROVIDER_ID,
        "--add-domains",
        "new.com",
        "--profile",
        first,
        "--profile",
        second,
      ],
      profileFlag: first,
    });
    return Effect.gen(function* () {
      const exit = yield* Effect.exit(
        legacySsoUpdate({ ...defaultFlags, addDomains: ["new.com"] }),
      );
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        const dump = JSON.stringify(exit.cause);
        expect(dump).toContain("LegacySsoAccessTokenError");
        expect(dump).toContain("Access token not provided. Supply an access token by running");
      }
      expect(api.requests).toHaveLength(0);
    }).pipe(Effect.ensuring(restoreEnv), Effect.provide(layer));
  });

  it.live("profile emulation: the missing-token gate fires AFTER the mutex check, like Go", () => {
    // cobra: ParseFlags → PreRunE → required → GROUPS → RunE(GetSupabase) —
    // the token gate lives in RunE, so a mutex violation must win even when
    // the reconciled profile has no token (validation-order parity).
    const first = writeProfileYaml("first-order.yml", "http://first.example");
    const second = writeProfileYaml("second-order.yml", "http://second.example");
    const restoreEnv = withProfileEnv(undefined);
    const { layer, api } = setup({
      accessToken: Option.none(),
      cliArgs: [
        "sso",
        "update",
        VALID_PROVIDER_ID,
        "--domains",
        "a.com",
        "--add-domains",
        "new.com",
        "--profile",
        first,
        "--profile",
        second,
      ],
      profileFlag: first,
    });
    return Effect.gen(function* () {
      const exit = yield* Effect.exit(
        legacySsoUpdate({ ...defaultFlags, domains: ["a.com"], addDomains: ["new.com"] }),
      );
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        const dump = JSON.stringify(exit.cause);
        expect(dump).toContain("[add-domains domains] were all set");
        expect(dump).not.toContain("Access token not provided");
      }
      expect(api.requests).toHaveLength(0);
    }).pipe(Effect.ensuring(restoreEnv), Effect.provide(layer));
  });

  it.live("profile emulation: the reconciled GET tolerates a body without a domains array", () => {
    const first = writeProfileYaml("first-nodom.yml", "http://first.example");
    const second = writeProfileYaml("second-nodom.yml", "http://second.example");
    const restoreEnv = withProfileEnv(undefined);
    const { layer, api } = setup({
      getBody: { id: VALID_PROVIDER_ID },
      cliArgs: [
        "sso",
        "update",
        VALID_PROVIDER_ID,
        "--add-domains",
        "new.com",
        "--profile",
        first,
        "--profile",
        second,
      ],
      profileFlag: first,
    });
    return Effect.gen(function* () {
      yield* legacySsoUpdate({ ...defaultFlags, addDomains: ["new.com"] });
      const put = api.requests.find((r) => r.method === "PUT");
      expect((put?.body as { domains?: string[] })?.domains).toEqual(["new.com"]);
    }).pipe(Effect.ensuring(restoreEnv), Effect.provide(layer));
  });

  it.live(
    "profile emulation: --profile consuming a trailing flag token fails LoadProfile, never GETs",
    () => {
      // `sso update <id> --profile --add-domains`: pflag binds
      // `"--add-domains"` as the profile value (positional count stays 1);
      // viper's extension gate rejects it before any request.
      const restoreEnv = withProfileEnv(undefined);
      const { layer, api } = setup({
        cliArgs: ["sso", "update", VALID_PROVIDER_ID, "--profile", "--add-domains"],
      });
      return Effect.gen(function* () {
        const exit = yield* Effect.exit(legacySsoUpdate(defaultFlags));
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

  it.live(
    "profile emulation: an undecodable 200 body from the reconciled GET aborts before the PUT",
    () => {
      // Go's generated `ParseV1GetASsoProviderResponse` unmarshals the 200
      // JSON body; the unmarshal error exits `update.Run` with `failed to
      // get sso provider: %w` before any PUT (`update.go:42-45`).
      const first = writeProfileYaml("first-badjson.yml", "http://first.example");
      const second = writeProfileYaml("second-badjson.yml", "http://second.example");
      const restoreEnv = withProfileEnv(undefined);
      const { layer, api } = setup({
        getRaw: { status: 200, body: "{not json", contentType: "application/json" },
        cliArgs: ["sso", "update", VALID_PROVIDER_ID, "--profile", first, "--profile", second],
        profileFlag: first,
      });
      return Effect.gen(function* () {
        const exit = yield* Effect.exit(legacySsoUpdate(defaultFlags));
        expect(Exit.isFailure(exit)).toBe(true);
        if (Exit.isFailure(exit)) {
          const dump = JSON.stringify(exit.cause);
          expect(dump).toContain("LegacySsoUpdateNetworkError");
          expect(dump).toContain("failed to get sso provider:");
        }
        expect(api.requests.some((r) => r.method === "PUT")).toBe(false);
      }).pipe(Effect.ensuring(restoreEnv), Effect.provide(layer));
    },
  );

  it.live(
    "profile emulation: a 200 without a JSON content type maps to the unexpected-status branch, like Go's nil JSON200",
    () => {
      // `update.go:47-55`: a 200 whose content type isn't JSON leaves
      // `JSON200` nil, so Go runs the gate check and errors with the raw
      // body — no PUT.
      const first = writeProfileYaml("first-nonjson.yml", "http://first.example");
      const second = writeProfileYaml("second-nonjson.yml", "http://second.example");
      const restoreEnv = withProfileEnv(undefined);
      const { layer, api } = setup({
        getRaw: { status: 200, body: "plain text body", contentType: "text/plain" },
        cliArgs: ["sso", "update", VALID_PROVIDER_ID, "--profile", first, "--profile", second],
        profileFlag: first,
      });
      return Effect.gen(function* () {
        const exit = yield* Effect.exit(legacySsoUpdate(defaultFlags));
        expect(Exit.isFailure(exit)).toBe(true);
        if (Exit.isFailure(exit)) {
          const dump = JSON.stringify(exit.cause);
          expect(dump).toContain("LegacySsoUpdateUnexpectedStatusError");
          expect(dump).toContain("unexpected error fetching identity provider: plain text body");
        }
        expect(api.requests.some((r) => r.method === "PUT")).toBe(false);
      }).pipe(Effect.ensuring(restoreEnv), Effect.provide(layer));
    },
  );

  it.live(
    "profile emulation: a gated 4xx on the reconciled GET sends the fallback gate requests to the reconciled host",
    () => {
      // Go's `SuggestUpgradeOnError` goes through `GetSupabase()` and the
      // process-wide reconciled `CurrentProfile`; the project + entitlement
      // fallback GETs must hit the same host as the main call.
      const first = writeProfileYaml("first-gate.yml", "http://first.example");
      const second = writeProfileYaml("second-gate.yml", "http://second.example");
      const restoreEnv = withProfileEnv(undefined);
      const { layer, api } = setup({
        getStatus: 403,
        getBody: {},
        upgradeGate: "gated",
        cliArgs: ["sso", "update", VALID_PROVIDER_ID, "--profile", first, "--profile", second],
        profileFlag: first,
      });
      return Effect.gen(function* () {
        const exit = yield* Effect.exit(legacySsoUpdate(defaultFlags));
        expect(Exit.isFailure(exit)).toBe(true);
        const project = api.requests.find((r) =>
          r.url.endsWith(`/v1/projects/${LEGACY_VALID_REF}`),
        );
        const entitlements = api.requests.find((r) => r.url.includes("/entitlements"));
        expect(project?.url).toBe(`http://second.example/v1/projects/${LEGACY_VALID_REF}`);
        expect(entitlements?.url).toBe("http://second.example/v1/organizations/acme/entitlements");
        expect(api.requests.some((r) => r.url.startsWith("http://first.example"))).toBe(false);
      }).pipe(Effect.ensuring(restoreEnv), Effect.provide(layer));
    },
  );

  it.live("profile emulation: the LoadProfile failure loses to the arity check, like Go", () => {
    // cobra: `ValidateArgs` runs before every hook (`command.go:968`), so a
    // wrong arg count is reported even when the profile is also unloadable
    // (binary-verified for workdir in round 6; LoadProfile sits in the same
    // PersistentPreRunE, before ChangeWorkDir).
    const restoreEnv = withProfileEnv(undefined);
    const { layer, api } = setup({
      cliArgs: ["sso", "update", "a", "b", "--profile", "--metadata-url", "u"],
    });
    return Effect.gen(function* () {
      const exit = yield* Effect.exit(legacySsoUpdate({ ...defaultFlags, providerId: "a" }));
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        const dump = JSON.stringify(exit.cause);
        expect(dump).toContain("LegacySsoUpdateArityError");
        expect(dump).not.toContain("LegacyProfileLoadError");
      }
      expect(api.requests.length).toBe(0);
    }).pipe(Effect.ensuring(restoreEnv), Effect.provide(layer));
  });
});
