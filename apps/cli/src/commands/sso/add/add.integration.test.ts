import { writeFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "@effect/vitest";
import { Effect, Exit, Layer, Option, Stdio } from "effect";
import * as HttpClientResponse from "effect/unstable/http/HttpClientResponse";

import { mockAnalytics, mockOutput } from "../../../../tests/helpers/mocks.ts";
import {
  buildTestRuntime,
  DEFAULT_API_URL,
  VALID_REF,
  mockCommandSettings,
  mockLinkedProjectCacheTracked,
  mockCommandPlatformApi,
  mockTelemetryStateTracked,
  useTempWorkdir,
} from "../../../../tests/helpers/command-mocks.ts";
import { ProfileFlag } from "../../../command-internal/global-flags.ts";
import { EventUpgradeSuggested } from "../../../shared/telemetry/event-catalog.ts";
import { classifyCliCauseActionability } from "../../../shared/telemetry/error-actionability.ts";
import { ssoAdd } from "./add.handler.ts";

const RESPONSE_PROVIDER = {
  id: "b5ae62f9-ef1d-4f11-a02b-731c8bbb11e8",
  saml: {
    entity_id: "https://example.com",
    attribute_mapping: { keys: { a: { name: "xyz", default: 3 } } },
  },
  domains: [{ domain: "example.com" }],
};

const tempRoot = useTempWorkdir("supabase-sso-add-int-");

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
   * Raw argv the handler sees via `Stdio.Stdio`, driving the pflag-faithful
   * scan behind the required-flag, mutex, and value-reconciliation checks.
   * Keep in sync with the flags passed to `ssoAdd` (usually via `cliArgsFor`).
   */
  cliArgs?: ReadonlyArray<string>;
  /**
   * The Effect-parsed `--profile` value. Must be set whenever `cliArgs`
   * carries a `--profile` the parser would have consumed.
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
  const telemetry = mockTelemetryStateTracked();
  const cache = mockLinkedProjectCacheTracked();

  const status = opts.status ?? 201;
  const body = opts.body ?? RESPONSE_PROVIDER;
  const gate = opts.upgradeGate;
  const metadataUrlResponse = opts.metadataUrlResponse;

  const api = mockCommandPlatformApi({
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
      if (url.endsWith(`/v1/projects/${VALID_REF}`)) {
        if (gate === undefined) return Effect.succeed(jsonResponse(request, 404, {}));
        return Effect.succeed(
          jsonResponse(request, 200, {
            id: VALID_REF,
            ref: VALID_REF,
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

  const cliSettings = mockCommandSettings({ workdir: tempRoot.current });
  const layer = Layer.mergeAll(
    buildTestRuntime({
      out,
      api: { layer: api.layer, httpClientLayer: api.httpClientLayer },
      cliSettings,
      telemetry: telemetry.layer,
      linkedProjectCache: cache.layer,
      analytics,
      goOutput: opts.goOutput === undefined ? Option.none() : Option.some(opts.goOutput),
    }),
    Stdio.layerTest({
      args: Effect.succeed(opts.cliArgs ?? ["sso", "add", "--type", "saml"]),
    }),
    opts.profileFlag === undefined ? Layer.empty : Layer.succeed(ProfileFlag, opts.profileFlag),
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
 * Serializes a flags record into matching raw argv, since the handler
 * reconciles the values it acts on against a scan of argv, not the flags
 * record itself.
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

describe("sso add integration", () => {
  it.live("POSTs to /v1/projects/{ref}/config/auth/sso/providers with type=saml", () => {
    const { layer, api } = setup();
    return Effect.gen(function* () {
      yield* ssoAdd(defaultFlags);
      const req = api.requests.find((r) => r.method === "POST");
      expect(req).toBeDefined();
      expect(req?.url).toContain(`/v1/projects/${VALID_REF}/config/auth/sso/providers`);
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
          ssoAdd({
            ...defaultFlags,
            metadataFile: Option.some("/tmp/missing.xml"),
            metadataUrl: Option.some("https://idp.example.com/m"),
          }),
        );
        expect(Exit.isFailure(exit)).toBe(true);
        if (Exit.isFailure(exit)) {
          const dump = JSON.stringify(exit.cause);
          expect(dump).toContain("SsoMutexFlagError");
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
          ssoAdd({
            ...defaultFlags,
            metadataFile: Option.some(""),
            metadataUrl: Option.some("https://idp.example.com/m"),
          }),
        );
        expect(Exit.isFailure(exit)).toBe(true);
        if (Exit.isFailure(exit)) {
          const dump = JSON.stringify(exit.cause);
          expect(dump).toContain("SsoMutexFlagError");
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
      const { layer, api } = setup({
        cliArgs: ["sso", "add", "--type", "saml", "--metadata-file", "--metadata-url"],
      });
      return Effect.gen(function* () {
        const exit = yield* Effect.exit(ssoAdd(defaultFlags));
        expect(Exit.isFailure(exit)).toBe(true);
        if (Exit.isFailure(exit)) {
          const dump = JSON.stringify(exit.cause);
          expect(dump).toContain("SsoAddMetadataFileError");
          expect(dump).toContain("failed to open metadata file");
        }
        expect(api.requests.some((r) => r.method === "POST")).toBe(false);
      }).pipe(Effect.provide(layer));
    },
  );

  it.live(
    "reconciles project-ref consuming --metadata-file: fails ref validation like Go, never reads metadata",
    () => {
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
          ssoAdd({
            ...defaultFlags,
            metadataFile: Option.some("file.xml"),
            metadataUrl: Option.some("https://idp.example.com/m"),
          }),
        );
        expect(Exit.isFailure(exit)).toBe(true);
        if (Exit.isFailure(exit)) {
          const dump = JSON.stringify(exit.cause);
          expect(dump).toContain("InvalidProjectRefError");
          expect(dump).toContain("Invalid project ref format. Must be like");
        }
        expect(api.requests.some((r) => r.method === "POST")).toBe(false);
      }).pipe(Effect.provide(layer));
    },
  );

  it.live(
    "required emulation: a bare --domains consuming --type fails the required-flag check, no POST",
    () => {
      const { layer, api } = setup({
        cliArgs: ["sso", "add", "--domains", "--type", "saml"],
      });
      return Effect.gen(function* () {
        const exit = yield* Effect.exit(ssoAdd(defaultFlags));
        expect(Exit.isFailure(exit)).toBe(true);
        if (Exit.isFailure(exit)) {
          const dump = JSON.stringify(exit.cause);
          expect(dump).toContain("SsoAddRequiredFlagError");
          expect(dump).toContain('required flag(s) \\"type\\" not set');
        }
        expect(api.requests.length).toBe(0);
      }).pipe(Effect.provide(layer));
    },
  );

  it.live("required emulation: the required-flag error wins over a mutex violation", () => {
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
        ssoAdd({
          ...defaultFlags,
          metadataFile: Option.some("a.xml"),
          metadataUrl: Option.some("https://idp.example.com/m"),
        }),
      );
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        const dump = JSON.stringify(exit.cause);
        expect(dump).toContain("SsoAddRequiredFlagError");
        expect(dump).not.toContain("SsoMutexFlagError");
      }
      expect(api.requests.length).toBe(0);
    }).pipe(Effect.provide(layer));
  });

  it.live(
    "workdir emulation: --workdir consuming --metadata-file fails at Go's chdir, never POSTs",
    () => {
      const { layer, api } = setup({
        cliArgs: [
          "sso",
          "add",
          "--type",
          "saml",
          "--project-ref",
          VALID_REF,
          "--workdir",
          "--metadata-file",
          "missing.xml",
        ],
      });
      return Effect.gen(function* () {
        const exit = yield* Effect.exit(
          ssoAdd({
            ...defaultFlags,
            projectRef: Option.some(VALID_REF),
            metadataFile: Option.some("missing.xml"),
          }),
        );
        expect(Exit.isFailure(exit)).toBe(true);
        if (Exit.isFailure(exit)) {
          const dump = JSON.stringify(exit.cause);
          expect(dump).toContain("PflagWorkdirError");
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
          ssoAdd({
            ...defaultFlags,
            metadataFile: Option.some("a.xml"),
            metadataUrl: Option.some("https://idp.example.com/m"),
          }),
        );
        expect(Exit.isFailure(exit)).toBe(true);
        if (Exit.isFailure(exit)) {
          const dump = JSON.stringify(exit.cause);
          expect(dump).toContain("PflagWorkdirError");
          expect(dump).toContain(
            "failed to change workdir: chdir /nonexistent-sso-add-workdir: no such file or directory",
          );
          expect(dump).not.toContain("SsoAddRequiredFlagError");
          expect(dump).not.toContain("SsoMutexFlagError");
        }
        expect(api.requests.length).toBe(0);
      }).pipe(Effect.provide(layer));
    },
  );

  it.live("workdir emulation: an existing --workdir directory proceeds to the POST", () => {
    const { layer, api } = setup({
      cliArgs: ["sso", "add", "--type", "saml", "--workdir", tempRoot.current],
    });
    return Effect.gen(function* () {
      yield* ssoAdd(defaultFlags);
      const req = api.requests.find((r) => r.method === "POST");
      expect((req?.body as { type?: string })?.type).toBe("saml");
    }).pipe(Effect.provide(layer));
  });

  it.live("required emulation: a -t shorthand invocation POSTs normally", () => {
    const { layer, api } = setup({
      cliArgs: ["sso", "add", "-t", "saml"],
    });
    return Effect.gen(function* () {
      yield* ssoAdd(defaultFlags);
      const req = api.requests.find((r) => r.method === "POST");
      expect((req?.body as { type?: string })?.type).toBe("saml");
    }).pipe(Effect.provide(layer));
  });

  it.live(
    "required emulation: -t saml plus a consumed --type still POSTs, like pflag (type IS changed)",
    () => {
      const { layer, api } = setup({
        cliArgs: ["sso", "add", "-t", "saml", "--domains", "--type", "saml"],
      });
      return Effect.gen(function* () {
        yield* ssoAdd(defaultFlags);
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
      const { layer, api } = setup({
        cliArgs: ["sso", "add", "--domains", "-t", "saml"],
      });
      return Effect.gen(function* () {
        const exit = yield* Effect.exit(ssoAdd(defaultFlags));
        expect(Exit.isFailure(exit)).toBe(true);
        if (Exit.isFailure(exit)) {
          const dump = JSON.stringify(exit.cause);
          expect(dump).toContain("SsoAddRequiredFlagError");
          expect(dump).toContain('required flag(s) \\"type\\" not set');
        }
        expect(api.requests.length).toBe(0);
      }).pipe(Effect.provide(layer));
    },
  );

  it.live(
    "invalid-value emulation: a later invalid --type occurrence fails with pflag's shorthand-labelled error, no POST",
    () => {
      const { layer, api } = setup({
        cliArgs: ["sso", "add", "--type", "saml", "--type", "bogus"],
      });
      return Effect.gen(function* () {
        const exit = yield* Effect.exit(ssoAdd(defaultFlags));
        expect(Exit.isFailure(exit)).toBe(true);
        if (Exit.isFailure(exit)) {
          const dump = JSON.stringify(exit.cause);
          expect(dump).toContain("SsoInvalidFlagValueError");
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
          ssoAdd({
            ...defaultFlags,
            skipUrlValidation: false, // Effect's first-wins parse
            metadataUrl: Option.some("https://idp.example.com/m"),
          }),
        );
        expect(Exit.isFailure(exit)).toBe(true);
        if (Exit.isFailure(exit)) {
          const dump = JSON.stringify(exit.cause);
          expect(dump).toContain("SsoInvalidFlagValueError");
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
        yield* ssoAdd({
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
        yield* ssoAdd({
          ...defaultFlags,
          nameIdFormat: Option.some(transient), // Effect's first-wins parse
        });
        const req = api.requests.find((r) => r.method === "POST");
        expect((req?.body as { name_id_format?: string })?.name_id_format).toBe(persistent);
      }).pipe(Effect.provide(layer));
    },
  );

  it.live("missing-value emulation: a trailing bare --domains fails pflag parse, no POST", () => {
    const { layer, api } = setup({
      cliArgs: ["sso", "add", "--type", "saml", "--domains"],
    });
    return Effect.gen(function* () {
      const exit = yield* Effect.exit(ssoAdd(defaultFlags));
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        const dump = JSON.stringify(exit.cause);
        expect(dump).toContain("SsoFlagNeedsArgumentError");
        expect(dump).toContain("flag needs an argument: --domains");
      }
      expect(api.requests.length).toBe(0);
    }).pipe(Effect.provide(layer));
  });

  it.live(
    "reconciles a bare --domains consuming --metadata-file: POSTs the domain pflag saw, no metadata",
    () => {
      const { layer, api } = setup({
        cliArgs: ["sso", "add", "--type", "saml", "--domains", "--metadata-file", "x.xml"],
      });
      return Effect.gen(function* () {
        yield* ssoAdd({ ...defaultFlags, metadataFile: Option.some("x.xml") });
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
          ssoAdd({
            ...defaultFlags,
            nameIdFormat: Option.some("urn:oasis:names:tc:SAML:2.0:nameid-format:persistent"),
          }),
        );
        expect(Exit.isFailure(exit)).toBe(true);
        if (Exit.isFailure(exit)) {
          const dump = JSON.stringify(exit.cause);
          expect(dump).toContain("SsoAddMetadataFileError");
          expect(dump).toContain("Use --skip-url-validation to suppress this error");
        }
        expect(api.requests.some((r) => r.method === "POST")).toBe(false);
      }).pipe(Effect.provide(layer));
    },
  );

  it.live("falls back to the parsed domains when the scan's raw values are malformed CSV", () => {
    // Unreachable via the real CLI; only tests that reconciliation doesn't crash on malformed input.
    const { layer, api } = setup({
      cliArgs: ["sso", "add", "--type", "saml", "--domains", '--x"y'],
    });
    return Effect.gen(function* () {
      yield* ssoAdd({ ...defaultFlags, domains: ["fallback.example.com"] });
      const req = api.requests.find((r) => r.method === "POST");
      expect((req?.body as { domains?: string[] })?.domains).toEqual(["fallback.example.com"]);
    }).pipe(Effect.provide(layer));
  });

  it.live("reads metadata file and sends as metadata_xml", () => {
    const path = join(tempRoot.current, "good.xml");
    writeFileSync(path, '<?xml version="1.0"?><md/>');
    const { layer, api } = setup({
      cliArgs: ["sso", "add", "--type", "saml", "--metadata-file", path],
    });
    return Effect.gen(function* () {
      yield* ssoAdd({ ...defaultFlags, metadataFile: Option.some(path) });
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
      const exit = yield* Effect.exit(ssoAdd(flags));
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        expect(JSON.stringify(exit.cause)).toContain("SsoAddMetadataFileError");
      }
    }).pipe(Effect.provide(layer));
  });

  it.live("sends metadata_url verbatim when --skip-url-validation", () => {
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
      yield* ssoAdd({
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
      yield* ssoAdd(flags);
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
      const exit = yield* Effect.exit(ssoAdd(flags));
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        const dump = JSON.stringify(exit.cause);
        expect(dump).toContain("only HTTPS Metadata URLs are supported");
        expect(dump).toContain("Use --skip-url-validation to suppress this error");
        expect(classifyCliCauseActionability(exit.cause)).toMatchObject({
          error_category: "invalid_input",
          suggestion_type: "provide_flags",
          error_fingerprint: "tag:SsoAddMetadataFileError:invalid_url",
        });
      }
    }).pipe(Effect.provide(layer));
  });

  it.live("reads attribute mapping JSON and preserves user-defined `default` field", () => {
    const path = join(tempRoot.current, "mapping.json");
    writeFileSync(path, JSON.stringify({ keys: { a: { default: 3 } } }));
    const flags = { ...defaultFlags, attributeMappingFile: Option.some(path) };
    const { layer, api } = setup({ cliArgs: cliArgsFor(flags) });
    return Effect.gen(function* () {
      yield* ssoAdd(flags);
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
      yield* ssoAdd(flags);
      const req = api.requests.find((r) => r.method === "POST");
      expect((req?.body as { domains?: string[] })?.domains).toEqual(["a.com", "b.com"]);
    }).pipe(Effect.provide(layer));
  });

  it.live("renders single-provider markdown in text mode", () => {
    const { layer, out } = setup();
    return Effect.gen(function* () {
      yield* ssoAdd(defaultFlags);
      expect(out.stdoutText).toContain("IDENTITY PROVIDER ID");
      expect(out.stdoutText).toContain(RESPONSE_PROVIDER.id);
    }).pipe(Effect.provide(layer));
  });

  it.live("Go --output=env returns no output", () => {
    const { layer, out } = setup({ goOutput: "env" });
    return Effect.gen(function* () {
      yield* ssoAdd(defaultFlags);
      expect(out.stdoutText).toBe("");
    }).pipe(Effect.provide(layer));
  });

  it.live("Go --output=json encodes response verbatim", () => {
    const { layer, out } = setup({ goOutput: "json" });
    return Effect.gen(function* () {
      yield* ssoAdd(defaultFlags);
      expect(out.stdoutText).toContain(RESPONSE_PROVIDER.id);
    }).pipe(Effect.provide(layer));
  });

  it.live("TS --output-format=json emits success", () => {
    const { layer, out } = setup({ format: "json" });
    return Effect.gen(function* () {
      yield* ssoAdd(defaultFlags);
      expect(out.messages.some((m) => m.type === "success")).toBe(true);
    }).pipe(Effect.provide(layer));
  });

  it.live("reports SAML-disabled error on 404", () => {
    const { layer } = setup({ status: 404, body: {} });
    return Effect.gen(function* () {
      const exit = yield* Effect.exit(ssoAdd(defaultFlags));
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        expect(JSON.stringify(exit.cause)).toContain("SsoAddSamlDisabledError");
      }
    }).pipe(Effect.provide(layer));
  });

  it.live("fires cli_upgrade_suggested on 404 when entitlement is gated", () => {
    const { layer, analytics } = setup({ status: 404, body: {}, upgradeGate: "gated" });
    return Effect.gen(function* () {
      yield* Effect.exit(ssoAdd(defaultFlags));
      expect(analytics.captured.some((c) => c.event === EventUpgradeSuggested)).toBe(true);
    }).pipe(Effect.provide(layer));
  });

  it.live("reports unexpected-status error on 500", () => {
    const { layer } = setup({ status: 500, body: { error: "boom" } });
    return Effect.gen(function* () {
      const exit = yield* Effect.exit(ssoAdd(defaultFlags));
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        const dump = JSON.stringify(exit.cause);
        expect(dump).toContain("SsoAddUnexpectedStatusError");
        expect(dump).toContain("Unexpected error adding identity provider");
      }
    }).pipe(Effect.provide(layer));
  });

  it.live("flushes telemetry + linked-project cache on success and failure", () => {
    const { layer, telemetry, cache } = setup({ status: 500, body: {} });
    return Effect.gen(function* () {
      yield* Effect.exit(ssoAdd(defaultFlags));
      expect(telemetry.flushed).toBe(true);
      expect(cache.cached).toBe(true);
    }).pipe(Effect.provide(layer));
  });

  it.live("Go --output=yaml encodes response verbatim", () => {
    const { layer, out } = setup({ goOutput: "yaml" });
    return Effect.gen(function* () {
      yield* ssoAdd(defaultFlags);
      expect(out.stdoutText).toContain(RESPONSE_PROVIDER.id);
    }).pipe(Effect.provide(layer));
  });

  it.live("Go --output=toml encodes response verbatim", () => {
    const { layer, out } = setup({ goOutput: "toml" });
    return Effect.gen(function* () {
      yield* ssoAdd(defaultFlags);
      expect(out.stdoutText).toContain(RESPONSE_PROVIDER.id);
    }).pipe(Effect.provide(layer));
  });

  it.live("preserves attribute_mapping `default` field in POST body", () => {
    const path = join(tempRoot.current, "mapping.json");
    writeFileSync(path, JSON.stringify({ keys: { a: { default: 42 } } }));
    const flags = { ...defaultFlags, attributeMappingFile: Option.some(path) };
    const { layer, api } = setup({ cliArgs: cliArgsFor(flags) });
    return Effect.gen(function* () {
      yield* ssoAdd(flags);
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
      const exit = yield* Effect.exit(ssoAdd(flags));
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        const dump = JSON.stringify(exit.cause);
        expect(dump).toContain("SsoAddMetadataFileError");
        expect(dump).toContain("Use --skip-url-validation to suppress this error");
      }
    }).pipe(Effect.provide(layer));
  });

  // Non-UTF-8 body coverage lives in `sso.saml.unit.test.ts`: this runtime's
  // `Response` constructor always emits valid UTF-8, so that case can't be
  // expressed here.

  it.live("malformed metadata URL surfaces invalid URI error", () => {
    const flags = {
      ...defaultFlags,
      metadataUrl: Option.some("::::not a url::::"),
      skipUrlValidation: false,
    };
    const { layer } = setup({ cliArgs: cliArgsFor(flags) });
    return Effect.gen(function* () {
      const exit = yield* Effect.exit(ssoAdd(flags));
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        expect(JSON.stringify(exit.cause)).toContain("SsoAddMetadataFileError");
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
      yield* ssoAdd(flags);
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
      const exit = yield* Effect.exit(ssoAdd(flags));
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        expect(JSON.stringify(exit.cause)).toContain("SsoAddAttributeMappingFileError");
      }
    }).pipe(Effect.provide(layer));
  });

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
      const envProfile = writeProfileYaml("env-profile.yml", "http://reconciled.example");
      const alternate = writeProfileYaml("alternate.yml", "http://alternate.example");
      const restoreEnv = withProfileEnv(envProfile);
      const { layer, api, cache } = setup({
        cliArgs: ["sso", "add", "--type", "saml", "--domains", "--profile", alternate],
        profileFlag: alternate,
      });
      return Effect.gen(function* () {
        yield* ssoAdd(defaultFlags);
        const posts = api.requests.filter((r) => r.method === "POST");
        expect(posts.length).toBe(1);
        expect(posts[0]?.url).toBe(
          `http://reconciled.example/v1/projects/${VALID_REF}/config/auth/sso/providers`,
        );
        expect((posts[0]?.body as { domains?: ReadonlyArray<string> })?.domains).toEqual([
          "--profile",
        ]);
        expect(cache.cachedApiUrl).toBe("http://reconciled.example");
      }).pipe(Effect.ensuring(restoreEnv), Effect.provide(layer));
    },
  );

  it.live(
    "profile emulation: --profile consuming a flag-shaped token fails LoadProfile, never POSTs",
    () => {
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
          ssoAdd({
            ...defaultFlags,
            metadataUrl: Option.some("https://idp.example.com/m"),
          }),
        );
        expect(Exit.isFailure(exit)).toBe(true);
        if (Exit.isFailure(exit)) {
          const dump = JSON.stringify(exit.cause);
          expect(dump).toContain("ProfileLoadError");
          expect(dump).toContain(`failed to read profile: Unsupported Config Type \\"\\"`);
        }
        expect(api.requests.length).toBe(0);
      }).pipe(Effect.ensuring(restoreEnv), Effect.provide(layer));
    },
  );

  it.live("profile emulation: repeated --profile resolves last-wins, matching pflag", () => {
    const first = writeProfileYaml("first.yml", "http://first.example");
    const second = writeProfileYaml("second.yml", "http://second.example");
    const restoreEnv = withProfileEnv(undefined);
    const { layer, api } = setup({
      cliArgs: ["sso", "add", "--type", "saml", "--profile", first, "--profile", second],
      profileFlag: first,
    });
    return Effect.gen(function* () {
      yield* ssoAdd(defaultFlags);
      const posts = api.requests.filter((r) => r.method === "POST");
      expect(posts.length).toBe(1);
      expect(posts[0]?.url).toBe(
        `http://second.example/v1/projects/${VALID_REF}/config/auth/sso/providers`,
      );
    }).pipe(Effect.ensuring(restoreEnv), Effect.provide(layer));
  });

  it.live(
    "profile emulation: the LoadProfile failure wins over the workdir, required-type, and mutex checks",
    () => {
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
          ssoAdd({
            ...defaultFlags,
            metadataUrl: Option.some("https://idp.example.com/m"),
            metadataFile: Option.some("a.xml"),
          }),
        );
        expect(Exit.isFailure(exit)).toBe(true);
        if (Exit.isFailure(exit)) {
          const dump = JSON.stringify(exit.cause);
          expect(dump).toContain("ProfileLoadError");
          expect(dump).not.toContain("PflagWorkdirError");
          expect(dump).not.toContain("SsoAddRequiredFlagError");
          expect(dump).not.toContain("SsoMutexFlagError");
        }
        expect(api.requests.length).toBe(0);
      }).pipe(Effect.ensuring(restoreEnv), Effect.provide(layer));
    },
  );

  it.live(
    "profile emulation: an agreeing --profile keeps the config layer's resolution (no override)",
    () => {
      const agreed = writeProfileYaml("agreed.yml", "http://agreed.example");
      const restoreEnv = withProfileEnv(undefined);
      const { layer, api } = setup({
        cliArgs: ["sso", "add", "--type", "saml", "--profile", agreed],
        profileFlag: agreed,
      });
      return Effect.gen(function* () {
        yield* ssoAdd(defaultFlags);
        const posts = api.requests.filter((r) => r.method === "POST");
        expect(posts.length).toBe(1);
        expect(posts[0]?.url).toBe(
          `${DEFAULT_API_URL}/v1/projects/${VALID_REF}/config/auth/sso/providers`,
        );
      }).pipe(Effect.ensuring(restoreEnv), Effect.provide(layer));
    },
  );
});
