import { Effect, Schema } from "effect";
// oxlint-disable-next-line effecttsgo/node-builtin-import -- template URLs use local path extensions.
import { extname } from "node:path";
import { ServiceError } from "../Service.ts";
import { EndpointIntent, serviceCreation } from "./Recipe.ts";
import { DEFAULT_SIGNING_KEY } from "../Defaults.ts";
import { localJwtSecret } from "./ServiceConfig.ts";
import { type ProcessRecipeSpec } from "./ProcessRecipe.ts";

import { Settings, settingsEnvironment } from "./AuthSettings.ts";

const defaultJwtKeys = Schema.encodeSync(Schema.fromJsonString(Schema.Array(Schema.Unknown)))([
  DEFAULT_SIGNING_KEY,
]);

const Smtp = Schema.Struct({
  host: Schema.String,
  port: Schema.Finite,
  user: Schema.String,
  pass: Schema.String,
  adminEmail: Schema.String,
  senderName: Schema.optionalKey(Schema.String),
});

const TemplateId = Schema.String.pipe(
  Schema.refine((value): value is string => /^[A-Za-z0-9_-]+$/u.test(value), {
    identifier: "AuthTemplateId",
    message: "Expected a safe Auth email template ID",
  }),
);

const Template = Schema.Struct({
  id: TemplateId,
  filePath: Schema.String,
});

export const Config = Schema.Struct({
  databaseUrl: Schema.String,
  siteUrl: Schema.optionalKey(Schema.String),
  apiExternalUrl: Schema.optionalKey(Schema.String),
  externalApiUrl: Schema.optionalKey(Schema.String),
  authExternalUrl: Schema.optionalKey(Schema.String),
  jwtSecret: Schema.optionalKey(Schema.String),
  gotrueJwtKeys: Schema.optionalKey(Schema.String),
  jwtExpiry: Schema.optionalKey(Schema.Finite),
  disableSignup: Schema.optionalKey(Schema.Boolean),
  smtpUrl: Schema.optionalKey(Schema.String),
  smtpAdminEmail: Schema.optionalKey(Schema.String),
  smtpSenderName: Schema.optionalKey(Schema.String),
  templates: Schema.optionalKey(Schema.Array(Template)),
  templateBaseUrl: Schema.optionalKey(Schema.String),
  settings: Schema.optionalKey(Settings),
  smtp: Schema.optionalKey(Smtp),
});

export interface Config extends Schema.Schema.Type<typeof Config> {}
export const Endpoints = Schema.Struct({ http: Schema.optionalKey(EndpointIntent) });

export interface Endpoints extends Schema.Schema.Type<typeof Endpoints> {}
export const Creation = serviceCreation("auth", Config, Endpoints);

export interface Creation extends Schema.Schema.Type<typeof Creation> {}

const templateEnvironment = (creation: Creation) =>
  Effect.gen(function* () {
    const templates = creation.config.templates;
    if (templates === undefined || templates.length === 0) return {};
    const baseUrl = creation.config.templateBaseUrl;
    if (baseUrl === undefined || baseUrl.length === 0)
      return yield* new ServiceError({
        operation: "launch",
        message: "Auth email templates require a template base URL",
      });
    const prefix = baseUrl.replace(/\/+$/u, "");
    return Object.fromEntries(
      templates.map(({ id, filePath }) => [
        `GOTRUE_MAILER_TEMPLATES_${id.toUpperCase()}`,
        `${prefix}/email/${id}${extname(filePath)}`,
      ]),
    );
  });

const smtpEnvironment = Effect.fn("Auth.smtpEnvironment")((value: string) =>
  Effect.try({
    try: () => {
      const url = new URL(value);
      return {
        GOTRUE_SMTP_HOST: url.hostname,
        GOTRUE_SMTP_PORT: url.port || "25",
        GOTRUE_SMTP_ADMIN_EMAIL: "noreply@example.com",
        ...(url.username === "" ? {} : { GOTRUE_SMTP_USER: decodeURIComponent(url.username) }),
        ...(url.password === "" ? {} : { GOTRUE_SMTP_PASS: decodeURIComponent(url.password) }),
      };
    },
    catch: (cause) => new ServiceError({ operation: "launch", message: String(cause), cause }),
  }),
);

export const makeSpec = (): ProcessRecipeSpec<Creation> => ({
  service: "auth",
  executable: "bin/auth",
  ports: { http: 9999 },
  healthPath: "/health",
  env: (creation, endpoints, container) =>
    Effect.gen(function* () {
      const templateValues = yield* templateEnvironment(creation);
      const http = endpoints.get("http");
      const apiExternalUrl = creation.config.apiExternalUrl;
      const authExternalUrl =
        creation.config.authExternalUrl !== undefined && creation.config.authExternalUrl.length > 0
          ? creation.config.authExternalUrl
          : apiExternalUrl !== undefined && apiExternalUrl.length > 0
            ? `${apiExternalUrl.replace(/\/+$/u, "")}/auth/v1`
            : (creation.config.externalApiUrl ??
              creation.config.siteUrl ??
              "http://localhost:3000");
      const jwtIssuer = creation.config.settings?.jwtIssuer || authExternalUrl;
      const base = {
        GOTRUE_API_HOST: container ? "0.0.0.0" : "127.0.0.1",
        GOTRUE_DB_DATABASE_URL: creation.config.databaseUrl,
        DATABASE_URL: creation.config.databaseUrl,
        GOTRUE_DB_DRIVER: "postgres",
        GOTRUE_SITE_URL: creation.config.siteUrl ?? "http://localhost:3000",
        GOTRUE_JWT_SECRET: creation.config.jwtSecret ?? localJwtSecret,
        GOTRUE_JWT_KEYS: creation.config.gotrueJwtKeys ?? defaultJwtKeys,
        GOTRUE_JWT_VALIDMETHODS: "HS256,RS256,ES256",
        GOTRUE_JWT_VALID_METHODS: "HS256,RS256,ES256",
        GOTRUE_JWT_AUD: "authenticated",
        GOTRUE_JWT_ADMIN_ROLES: "service_role",
        GOTRUE_JWT_DEFAULT_GROUP_NAME: "authenticated",
        GOTRUE_MAILER_AUTOCONFIRM: "true",
        GOTRUE_MAILER_TEMPLATE_RELOADING_ENABLED: "true",
        GOTRUE_DISABLE_SIGNUP: String(creation.config.disableSignup ?? false),
        GOTRUE_RATE_LIMIT_EMAIL_SENT: "360000",
        ...(http === undefined ? {} : { GOTRUE_API_PORT: String(http.port) }),
        API_EXTERNAL_URL: authExternalUrl,
        GOTRUE_JWT_ISSUER: jwtIssuer,
        GOTRUE_MAILER_URLPATHS_INVITE: `${authExternalUrl.replace(/\/+$/u, "")}/verify`,
        GOTRUE_MAILER_URLPATHS_CONFIRMATION: `${authExternalUrl.replace(/\/+$/u, "")}/verify`,
        GOTRUE_MAILER_URLPATHS_RECOVERY: `${authExternalUrl.replace(/\/+$/u, "")}/verify`,
        GOTRUE_MAILER_URLPATHS_EMAIL_CHANGE: `${authExternalUrl.replace(/\/+$/u, "")}/verify`,
        ...(creation.config.jwtExpiry === undefined
          ? {}
          : { GOTRUE_JWT_EXP: String(creation.config.jwtExpiry) }),
        ...settingsEnvironment(creation.config.settings, jwtIssuer),
        ...templateValues,
      };
      const smtp = creation.config.smtp;
      if (smtp !== undefined) {
        return {
          ...base,
          GOTRUE_SMTP_HOST: smtp.host,
          GOTRUE_SMTP_PORT: String(smtp.port),
          GOTRUE_SMTP_USER: smtp.user,
          GOTRUE_SMTP_PASS: smtp.pass,
          GOTRUE_SMTP_ADMIN_EMAIL: smtp.adminEmail,
          ...(creation.config.settings?.rateLimit?.email_sent === undefined
            ? {}
            : {
                GOTRUE_RATE_LIMIT_EMAIL_SENT: String(creation.config.settings.rateLimit.email_sent),
              }),
          ...(smtp.senderName === undefined ? {} : { GOTRUE_SMTP_SENDER_NAME: smtp.senderName }),
        };
      }
      return creation.config.smtpUrl === undefined
        ? base
        : yield* smtpEnvironment(creation.config.smtpUrl).pipe(
            Effect.map((value) => ({
              ...base,
              ...value,
              ...(creation.config.smtpAdminEmail === undefined
                ? {}
                : { GOTRUE_SMTP_ADMIN_EMAIL: creation.config.smtpAdminEmail }),
              ...(creation.config.smtpSenderName === undefined
                ? {}
                : { GOTRUE_SMTP_SENDER_NAME: creation.config.smtpSenderName }),
            })),
          );
    }),
  args: () => Effect.succeed([]),
  mounts: () => Effect.succeed([]),
  startup: [
    { args: ["migrate"], nativeExecutable: "auth", containerEntrypoint: "/usr/local/bin/auth" },
  ],
});
