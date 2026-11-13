import { SMS_PROVIDER_REQUIRED_FIELDS } from "@supabase/config/internal";
import { Effect, Path, Result } from "effect";

import { defaultJwtSecret } from "../shared/stack-constants.ts";
import {
  countingUnit,
  finding,
  invalid,
  missing,
  nonEmpty,
  num,
  readText,
  str,
  syncUnit,
  thrown,
  type CliConfigCheckUnit,
  type CliConfigUnitFinding,
  type CliConfigView,
  type CountingCliConfigView,
  type Segments,
} from "./config-check-core.ts";
import {
  ConfigValidateError,
  CLERK_DOMAIN_PATTERN,
  emailContentPathReadErrorMessage,
  fsErrorCause,
  HOOK_SECRET_PATTERN,
  messageOf,
  MIN_JWT_SECRET_LENGTH,
  rawUnmodeledBool,
  resolveEmailTemplateContentPath,
  resolveJwtSecret,
  resolveSignedKey,
  resolveSigningKeysPath,
  signingKeysDecodeErrorMessage,
  signingKeysReadErrorMessage,
  thrownError,
} from "./config-validate.ts";
import { DEFAULT_SIGNING_KEY, type Jwk } from "./local-jwt.ts";
import {
  authExternalProviderNames,
  HOOK_TYPE_ORDER,
  rawOrigins,
  readSigningKeys,
  SMTP_ENABLED_PATH,
  SMTP_PATH,
  smtpSwitchOn,
} from "./local-config-helpers.ts";
import { parseDuration } from "./duration.ts";
import { parseUrl } from "./storage-url.ts";

const AUTH_ENABLED = ["auth", "enabled"] as const;
const authOn = (view: CliConfigView): boolean => view.get(AUTH_ENABLED) === true;

const smtpOnInView = (view: CliConfigView): boolean =>
  smtpSwitchOn(
    view.written(SMTP_ENABLED_PATH),
    () => view.get(SMTP_ENABLED_PATH),
    () => view.has(SMTP_PATH),
  );

export const smtpField = (view: CliConfigView, field: string): unknown =>
  view.written([...SMTP_PATH, field]) ?? view.get([...SMTP_PATH, field]);

const PASSKEY_ENABLED = ["auth", "passkey", "enabled"] as const;

const passkeyOn = (view: CliConfigView): boolean => {
  try {
    return rawUnmodeledBool(view.written(PASSKEY_ENABLED), "auth.passkey.enabled");
  } catch {
    view.defer(PASSKEY_ENABLED);
    return false;
  }
};

const SIGNING_KEYS_PATH = ["auth", "signing_keys_path"] as const;
const SIGNING_KEYS_ISSUE = {
  reason: "signing keys file is missing, unreadable or invalid",
  help: "point signing_keys_path at a JSON array of JWKs, relative to the supabase/ directory",
} as const;

export const authJwtSecret = syncUnit({
  id: "auth.jwt_secret",
  scope: ["auth", "jwt_secret"],
  kind: "value",
  check: (view) => {
    try {
      resolveJwtSecret(str(view.get(["auth", "jwt_secret"])));
      return [];
    } catch (cause) {
      return [
        thrown(
          ["auth", "jwt_secret"],
          cause,
          "too short",
          `use at least ${MIN_JWT_SECRET_LENGTH} characters`,
        ),
      ];
    }
  },
});

export const authSigningKeys: CliConfigCheckUnit = {
  id: "auth.signing_keys",
  scope: ["auth"],
  kind: "file",
  run: Effect.fnUntraced(function* (view, io) {
    const signingKeysPath = nonEmpty(view.get(SIGNING_KEYS_PATH));
    if (!authOn(view) || signingKeysPath === undefined) return [];
    const result = yield* Effect.result(readSigningKeys(io, view.workdir, signingKeysPath));
    return Result.isFailure(result)
      ? [
          finding(
            SIGNING_KEYS_PATH,
            "invalid_value",
            result.failure.message,
            SIGNING_KEYS_ISSUE.reason,
            SIGNING_KEYS_ISSUE.help,
            result.failure,
          ),
        ]
      : [];
  }),
};

const signingKeysShapeError = (contents: string): string | undefined => {
  let parsed: unknown;
  try {
    // oxlint-disable-next-line effecttsgo/prefer-schema-over-json -- Native parser errors are CLI output; schema decoding discards their messages.
    parsed = JSON.parse(contents);
  } catch (cause) {
    return signingKeysDecodeErrorMessage(cause);
  }
  return Array.isArray(parsed)
    ? undefined
    : signingKeysDecodeErrorMessage("signing keys must be a JSON array of JWKs");
};

/** The DB pipeline's signing-keys check, which only needs a JSON array and quotes the platform error. */
export const DB_SIGNING_KEYS_UNIT: CliConfigCheckUnit = {
  id: "auth.signing_keys.db",
  scope: ["auth"],
  kind: "file",
  run: Effect.fnUntraced(function* (view, io) {
    const signingKeysPath = nonEmpty(view.get(SIGNING_KEYS_PATH));
    if (!authOn(view) || signingKeysPath === undefined) return [];
    const path = yield* Path.Path;
    const read = yield* readText(io, resolveSigningKeysPath(path, view.workdir, signingKeysPath));
    const fail = (message: string) => [
      finding(
        SIGNING_KEYS_PATH,
        "invalid_value",
        message,
        SIGNING_KEYS_ISSUE.reason,
        SIGNING_KEYS_ISSUE.help,
      ),
    ];
    if (Result.isFailure(read)) {
      return fail(signingKeysReadErrorMessage(io.readFailureCause(read.failure)));
    }
    const decodeError = signingKeysShapeError(read.success);
    return decodeError === undefined ? [] : fail(decodeError);
  }),
};

export const authPasskeyEnabled = syncUnit({
  id: "auth.passkey.enabled",
  scope: ["auth"],
  kind: "requirement",
  check: (view) => {
    if (!authOn(view)) return [];
    try {
      rawUnmodeledBool(view.written(["auth", "passkey", "enabled"]), "auth.passkey.enabled");
      return [];
    } catch (cause) {
      return [
        thrown(
          ["auth", "passkey", "enabled"],
          cause,
          "expected a boolean",
          "use true or false",
          "invalid_type",
        ),
      ];
    }
  },
});

export const authWebauthn = syncUnit({
  id: "auth.webauthn",
  scope: ["auth"],
  kind: "requirement",
  check: (view) => {
    if (!authOn(view) || !passkeyOn(view)) return [];
    const gate = ["auth", "passkey", "enabled"] as const;
    if (!view.has(["auth", "webauthn"])) {
      return [
        missing(["auth", "webauthn"], gate, {
          message:
            "Missing required config section: auth.webauthn (required when auth.passkey.enabled is true)",
          help: "add an [auth.webauthn] section, or set auth.passkey.enabled = false",
        }),
      ];
    }
    const findings: Array<CliConfigUnitFinding> = [];
    if (nonEmpty(view.written(["auth", "webauthn", "rp_id"])) === undefined) {
      findings.push(missing(["auth", "webauthn", "rp_id"], gate));
    }
    const origins = rawOrigins(view.written(["auth", "webauthn", "rp_origins"]));
    if (origins === undefined || origins.length === 0) {
      findings.push(missing(["auth", "webauthn", "rp_origins"], gate));
    }
    return findings;
  },
});

export const authHooks = syncUnit({
  id: "auth.hook",
  scope: ["auth"],
  kind: "requirement",
  entries: () => HOOK_TYPE_ORDER,
  check: (view, type) => {
    const hookPath = ["auth", "hook", type] as const;
    const gate = [...hookPath, "enabled"] as const;
    if (!authOn(view) || view.get(gate) !== true) return [];
    const uri = str(view.get([...hookPath, "uri"])) ?? "";
    const secretsOf = (): string => str(view.get([...hookPath, "secrets"])) ?? "";
    const uriPath = [...hookPath, "uri"] as const;
    const secretsPath = [...hookPath, "secrets"] as const;
    if (uri.length === 0) return [missing(uriPath, gate)];
    let scheme: string;
    try {
      scheme = parseUrl(uri).scheme;
    } catch (cause) {
      return [
        invalid(
          uriPath,
          `failed to parse template url: ${messageOf(cause)}`,
          "not a valid URI",
          "use an http(s):// or pg-functions:// URI",
        ),
      ];
    }
    if (scheme === "http" || scheme === "https") {
      const secrets = secretsOf();
      if (secrets.length === 0) return [missing(secretsPath, gate)];
      return secrets.split("|").every((secret) => HOOK_SECRET_PATTERN.test(secret))
        ? []
        : [
            invalid(
              secretsPath,
              `Invalid hook config: auth.hook.${type}.secrets must be formatted as "v1,whsec_<base64_encoded_secret>" with a minimum length of 32 characters.`,
              "not a valid webhook secret",
              'format it as "v1,whsec_<base64 secret>" with at least 32 characters; separate several with |',
            ),
          ];
    }
    if (scheme === "pg-functions") {
      return secretsOf().length > 0
        ? [
            invalid(
              secretsPath,
              `Invalid hook config: auth.hook.${type}.secrets is unsupported for pg-functions URI`,
              "not supported for a pg-functions URI",
              "remove secrets, or use an http(s) URI",
            ),
          ]
        : [];
    }
    return [
      invalid(
        uriPath,
        `Invalid hook config: auth.hook.${type}.uri should be a HTTP, HTTPS, or pg-functions URI`,
        "unsupported URI scheme",
        "use an http(s):// or pg-functions:// URI",
      ),
    ];
  },
});

export const authMfa = syncUnit({
  id: "auth.mfa",
  scope: ["auth"],
  kind: "requirement",
  entries: () => ["totp", "phone", "web_authn"],
  check: (view, factor) => {
    if (
      !authOn(view) ||
      view.get(["auth", "mfa", factor, "enroll_enabled"]) !== true ||
      view.get(["auth", "mfa", factor, "verify_enabled"]) === true
    ) {
      return [];
    }
    return [
      invalid(
        ["auth", "mfa", factor, "enroll_enabled"],
        `Invalid MFA config: auth.mfa.${factor}.enroll_enabled requires verify_enabled`,
        "requires verify_enabled = true",
        `set auth.mfa.${factor}.verify_enabled = true, or disable enroll_enabled`,
      ),
    ];
  },
});

const durationUnit = (path: Segments): CliConfigCheckUnit => {
  const dotted = path.join(".");
  return syncUnit({
    id: `${dotted}.duration`,
    scope: path,
    kind: "value",
    check: (view) => {
      const value = str(view.get(path));
      if (value === undefined) return [];
      try {
        parseDuration(value);
        return [];
      } catch (cause) {
        return [
          invalid(
            path,
            `invalid config for ${dotted}: ${messageOf(cause)}`,
            "not a valid duration",
            'use a duration such as "1h" or "30m"',
          ),
        ];
      }
    },
  });
};

export const authDurationUnits: ReadonlyArray<CliConfigCheckUnit> = [
  ["auth", "email", "max_frequency"],
  ["auth", "sms", "max_frequency"],
  ["auth", "sessions", "timebox"],
  ["auth", "sessions", "inactivity_timeout"],
  ["auth", "mfa", "phone", "max_frequency"],
].map(durationUnit);

export const emailContentUnit = (section: "template" | "notification"): CliConfigCheckUnit => ({
  id: `auth.email.${section}.content_path`,
  scope: ["auth"],
  kind: "file",
  entries: (view) => view.keys(["auth", "email", section]),
  run: Effect.fnUntraced(function* (view, io, name = "") {
    if (!authOn(view)) return [];
    const base = ["auth", "email", section, name] as const;
    if (section === "notification" && view.get([...base, "enabled"]) !== true) return [];
    const at = [...base, "content_path"] as const;
    const reason = "content_path is not a readable file inside the project";
    const help = "point content_path at an existing file under the project root";
    const resolved = yield* Effect.result(
      resolveEmailTemplateContentPath({
        section,
        name,
        contentPath: str(view.get(at)) ?? "",
        contentPresent: view.written([...base, "content"]) !== undefined,
        base: view.workdir,
      }),
    );
    if (Result.isFailure(resolved)) {
      const error =
        resolved.failure instanceof ConfigValidateError
          ? resolved.failure
          : thrownError(fsErrorCause(resolved.failure));
      return [finding(at, "invalid_value", error.message, reason, help, error)];
    }
    if (resolved.success === undefined) return [];
    const read = yield* readText(io, resolved.success);
    return Result.isFailure(read)
      ? [
          invalid(
            at,
            emailContentPathReadErrorMessage(section, name, io.readFailureCause(read.failure)),
            reason,
            help,
          ),
        ]
      : [];
  }),
});
export const authSiteUrl = syncUnit({
  id: "auth.site_url",
  scope: ["auth"],
  kind: "requirement",
  check: (view) =>
    authOn(view) && (str(view.get(["auth", "site_url"])) ?? "").length === 0
      ? [missing(["auth", "site_url"])]
      : [],
});

export const authCaptchaProvider = syncUnit({
  id: "auth.captcha.provider",
  scope: ["auth"],
  kind: "requirement",
  check: (view) => {
    const provider = nonEmpty(view.get(["auth", "captcha", "provider"]));
    return authOn(view) &&
      provider !== undefined &&
      provider !== "hcaptcha" &&
      provider !== "turnstile"
      ? [
          invalid(
            ["auth", "captcha", "provider"],
            "failed to parse config:\nauth.captcha.provider: must be one of hcaptcha, turnstile",
            "expected one of hcaptcha, turnstile",
            "use hcaptcha or turnstile",
            "invalid_enum",
          ),
        ]
      : [];
  },
});

export const authCaptcha = syncUnit({
  id: "auth.captcha",
  scope: ["auth"],
  kind: "requirement",
  check: (view) => {
    const gate = ["auth", "captcha", "enabled"] as const;
    const provider = nonEmpty(view.get(["auth", "captcha", "provider"]));
    if (!authOn(view) || view.get(gate) !== true) return [];
    if (provider !== undefined && provider !== "hcaptcha" && provider !== "turnstile") return [];
    const findings: Array<CliConfigUnitFinding> = [];
    if (provider === undefined) findings.push(missing(["auth", "captcha", "provider"], gate));
    if (nonEmpty(view.get(["auth", "captcha", "secret"])) === undefined) {
      findings.push(missing(["auth", "captcha", "secret"], gate));
    }
    return findings;
  },
});

export const SMTP_FIELDS = ["host", "port", "user", "pass", "admin_email"] as const;

export const authSmtpFieldUnits = SMTP_FIELDS.map((field) =>
  syncUnit({
    id: `auth.email.smtp.${field}`,
    scope: ["auth"],
    kind: "requirement",
    check: (view) => {
      if (!authOn(view) || !smtpOnInView(view)) return [];
      const value = smtpField(view, field);
      const absent = field === "port" ? num(value) === 0 : (str(value) ?? "").length === 0;
      return absent ? [missing([...SMTP_PATH, field], SMTP_ENABLED_PATH)] : [];
    },
  }),
);

const thirdPartyBase = (provider: string) => ["auth", "third_party", provider] as const;

const thirdPartyMessage = (label: string, field: string) =>
  `Invalid config: auth.third_party.${label} is enabled but without a ${field}.`;

const thirdPartyUnit = (
  provider: "firebase" | "auth0" | "aws_cognito" | "clerk" | "workos",
  check: (
    view: CliConfigView,
    base: ReturnType<typeof thirdPartyBase>,
    gate: Segments,
  ) => ReadonlyArray<CliConfigUnitFinding>,
) =>
  syncUnit({
    id: `auth.third_party.${provider}`,
    scope: ["auth"],
    kind: "requirement",
    check: (view) => {
      const base = thirdPartyBase(provider);
      const gate = [...base, "enabled"] as const;
      return authOn(view) && view.get(gate) === true ? check(view, base, gate) : [];
    },
  });

const requiredField = (
  view: CliConfigView,
  base: ReturnType<typeof thirdPartyBase>,
  gate: Segments,
  label: string,
  field: string,
): ReadonlyArray<CliConfigUnitFinding> =>
  (str(view.get([...base, field])) ?? "").length === 0
    ? [missing([...base, field], gate, { message: thirdPartyMessage(label, field) })]
    : [];

export const thirdPartyUnits = [
  thirdPartyUnit("firebase", (view, base, gate) =>
    requiredField(view, base, gate, "firebase", "project_id"),
  ),
  thirdPartyUnit("auth0", (view, base, gate) => requiredField(view, base, gate, "auth0", "tenant")),
  thirdPartyUnit("aws_cognito", (view, base, gate) => {
    const poolId = requiredField(view, base, gate, "cognito", "user_pool_id");
    return poolId.length > 0
      ? poolId
      : requiredField(view, base, gate, "cognito", "user_pool_region");
  }),
  thirdPartyUnit("clerk", (view, base, gate) => {
    const domain = str(view.get([...base, "domain"])) ?? "";
    if (domain.length === 0) return requiredField(view, base, gate, "clerk", "domain");
    return CLERK_DOMAIN_PATTERN.test(domain)
      ? []
      : [
          invalid(
            [...base, "domain"],
            "Invalid config: auth.third_party.clerk has invalid domain, it usually is like clerk.example.com or example.clerk.accounts.dev. Check https://clerk.com/setup/supabase on how to find the correct value.",
            "not a Clerk domain",
            "use a domain like clerk.example.com or example.clerk.accounts.dev; see https://clerk.com/setup/supabase",
          ),
        ];
  }),
  thirdPartyUnit("workos", (view, base, gate) =>
    requiredField(view, base, gate, "workos", "issuer_url"),
  ),
];

const THIRD_PARTY_PROVIDER_KEYS = ["firebase", "auth0", "aws_cognito", "clerk", "workos"] as const;

export const authThirdPartyOnlyOne = countingUnit({
  id: "auth.third_party",
  scope: ["auth"],
  check: (view) => {
    if (!authOn(view)) return [];
    let enabled = 0;
    let unsettled: Segments | undefined;
    let unknownCount = 0;
    for (const provider of THIRD_PARTY_PROVIDER_KEYS) {
      const gate = [...thirdPartyBase(provider), "enabled"];
      if (!view.isKnown(gate)) {
        unsettled ??= gate;
        unknownCount += 1;
      } else if (view.get(gate) === true) {
        enabled += 1;
      }
    }
    if (enabled > 1) {
      return [
        invalid(
          ["auth", "third_party"],
          "Invalid config: Only one third_party provider allowed to be enabled at a time.",
          "more than one third-party provider is enabled",
          "enable one auth.third_party provider and set enabled = false on the others",
        ),
      ];
    }
    // Reading the first unknown flag records the dependency, so a validator defers this check;
    // a lone unknown flag with no known provider enabled cannot break the rule.
    if (unsettled !== undefined && enabled + unknownCount > 1) view.get(unsettled);
    return [];
  },
});

/** The first enabled sms provider; reads an unknown flag it cannot get past, so a validator defers. */
export const firstEnabledSmsProvider = (
  view: CountingCliConfigView,
): (typeof SMS_PROVIDER_REQUIRED_FIELDS)[number] | undefined => {
  for (const provider of SMS_PROVIDER_REQUIRED_FIELDS) {
    const gate = ["auth", "sms", provider[0], "enabled"];
    if (!view.isKnown(gate)) {
      view.get(gate);
      return undefined;
    }
    if (view.get(gate) === true) return provider;
  }
  return undefined;
};

export const authSmsProvider = countingUnit({
  id: "auth.sms.provider",
  scope: ["auth"],
  check: (view) => {
    if (!authOn(view)) return [];
    const provider = firstEnabledSmsProvider(view);
    if (provider === undefined) return [];
    const gate = ["auth", "sms", provider[0], "enabled"];
    return provider[1]
      .filter((field) => (str(view.get(["auth", "sms", provider[0], field])) ?? "").length === 0)
      .map((field) => missing(["auth", "sms", provider[0], field], gate));
  },
});

export const externalNames = (view: CliConfigView): ReadonlyArray<string> =>
  authExternalProviderNames(view.keys(["auth", "external"]));

/** The boolean at `field` of an external provider, from the decoded value or, for custom providers, the document. */
const externalBool = (view: CliConfigView, name: string, field: string): boolean => {
  const decoded = view.get(["auth", "external", name, field]);
  return typeof decoded === "boolean"
    ? decoded
    : rawUnmodeledBool(
        view.written(["auth", "external", name, field]),
        `auth.external.${name}.${field}`,
      );
};

const hasExternalProvider = (view: CliConfigView, name: string): boolean =>
  view.keys(["auth", "external"]).includes(name);

export const authExternalBooleans = syncUnit({
  id: "auth.external.booleans",
  scope: ["auth"],
  kind: "requirement",
  entries: externalNames,
  check: (view, name) => {
    if (!authOn(view) || !hasExternalProvider(view, name)) return [];
    try {
      for (const field of ["enabled", "skip_nonce_check", "email_optional"]) {
        externalBool(view, name, field);
      }
      return [];
    } catch (cause) {
      return [
        thrown(
          ["auth", "external", name],
          cause,
          "expected booleans for enabled, skip_nonce_check and email_optional",
          "use true or false",
          "invalid_type",
        ),
      ];
    }
  },
});

export const externalText = (
  view: CliConfigView,
  name: string,
  field: string,
): string | undefined =>
  str(view.get(["auth", "external", name, field])) ??
  str(view.written(["auth", "external", name, field]));

export const externalEnabled = (view: CliConfigView, name: string): boolean => {
  try {
    return hasExternalProvider(view, name) && externalBool(view, name, "enabled");
  } catch {
    view.defer(["auth", "external", name, "enabled"]);
    return false;
  }
};

export const authExternalRequired = syncUnit({
  id: "auth.external.required",
  scope: ["auth"],
  kind: "requirement",
  entries: externalNames,
  check: (view, name) => {
    if (!authOn(view) || !externalEnabled(view, name)) return [];
    const gate = ["auth", "external", name, "enabled"];
    const findings: Array<CliConfigUnitFinding> = [];
    if ((externalText(view, name, "client_id") ?? "").length === 0) {
      findings.push(missing(["auth", "external", name, "client_id"], gate));
    }
    if (
      name !== "apple" &&
      name !== "google" &&
      (externalText(view, name, "secret") ?? "").length === 0
    ) {
      findings.push(missing(["auth", "external", name, "secret"], gate));
    }
    return findings;
  },
});

const SIGNED_KEY_ISSUE = {
  reason: "could not be generated",
  help: "set the key explicitly, or fix the signing keys configuration",
} as const;

const jwtSecretOrDefault = (view: CliConfigView): string => {
  try {
    return resolveJwtSecret(str(view.get(["auth", "jwt_secret"])));
  } catch {
    return defaultJwtSecret;
  }
};

const signedKeyFindings = (
  view: CliConfigView,
  jwtSecret: string,
  signingKey: Jwk | undefined,
): ReadonlyArray<CliConfigUnitFinding> => {
  const findings: Array<CliConfigUnitFinding> = [];
  for (const [key, role] of [
    ["anon_key", "anon"],
    ["service_role_key", "service_role"],
  ] as const) {
    try {
      resolveSignedKey(str(view.get(["auth", key])), jwtSecret, signingKey, role);
    } catch (cause) {
      findings.push(thrown(["auth", key], cause, SIGNED_KEY_ISSUE.reason, SIGNED_KEY_ISSUE.help));
    }
  }
  return findings;
};

export const authSignedKeys: CliConfigCheckUnit = {
  id: "auth.signed_keys",
  scope: ["auth"],
  kind: "file",
  run: Effect.fnUntraced(function* (view, io) {
    const jwtSecret = jwtSecretOrDefault(view);
    const signingKeysPath = nonEmpty(view.get(SIGNING_KEYS_PATH));
    let signingKey: Jwk | undefined;
    if (signingKeysPath !== undefined) {
      if (authOn(view)) {
        const keys = yield* Effect.result(readSigningKeys(io, view.workdir, signingKeysPath));
        if (Result.isFailure(keys)) return [];
        signingKey = keys.success[0];
      } else {
        signingKey = DEFAULT_SIGNING_KEY;
      }
    }
    return signedKeyFindings(view, jwtSecret, signingKey);
  }),
};
