import { BunServices } from "@effect/platform-bun";
import { describe, expect, it } from "@effect/vitest";
import { Effect, FileSystem, Layer, Redacted, Schema } from "effect";
import { ServiceCreation } from "../../../../../../packages/stack/src/services/Catalog.ts";
import { makeSpec as authSpec } from "../../../../../../packages/stack/src/services/Auth.ts";
import { makeSpec as restSpec } from "../../../../../../packages/stack/src/services/Rest.ts";
import { makeSpec as poolerSpec } from "../../../../../../packages/stack/src/services/Pooler.ts";
import { makeSpec as realtimeSpec } from "../../../../../../packages/stack/src/services/Realtime.ts";
import { makeSpec as storageSpec } from "../../../../../../packages/stack/src/services/Storage.ts";
import { makeSpec as studioSpec } from "../../../../../../packages/stack/src/services/Studio.ts";
import { loadStackConfig } from "../../../command-internal/stack-config.ts";
import { runtimeInfoLayer } from "../../../shared/runtime/runtime-info.layer.ts";
import { createStackConfigProject } from "../../../../tests/helpers/stack-config.ts";

const layer = Layer.merge(BunServices.layer, runtimeInfoLayer);

describe("stack service configuration", () => {
  it.live("carries editable TOML settings into native and container service environments", () =>
    Effect.gen(function* () {
      const root = yield* createStackConfigProject(`project_id = "forwarding"
[api]
extra_search_path = ["public", "extensions", "custom"]
[db]
health_timeout = "12.5s"
root_key = "${"a".repeat(64)}"
[db.pooler]
enabled = true
default_pool_size = 7
max_client_conn = 42
[realtime]
ip_version = "IPv6"
max_header_length = 8192
[studio]
api_url = "https://public.example.test"
openai_api_key = "test-openai-key"
[storage.s3_protocol]
enabled = false
[storage.vector]
enabled = false
max_buckets = 3
max_indexes = 2
[analytics]
vector_port = 59001
`);
      const loaded = yield* loadStackConfig(root);
      const services = yield* loaded.creations("forwarding");
      const database = services.find((s) => s.service === "database");
      expect(database?.config.healthTimeoutMs).toBe(12500);
      expect(database?.config.rootKey && Redacted.value(database.config.rootKey)).toBe(
        "a".repeat(64),
      );
      expect(services.find((s) => s.service === "vector")?.endpoints?.http?.port).toBe(59001);
      for (const container of [false, true]) {
        for (const service of services) {
          switch (service.service) {
            case "rest":
              expect(yield* restSpec().env(service, new Map(), container)).toMatchObject({
                PGRST_DB_EXTRA_SEARCH_PATH: "public,extensions,custom",
              });
              break;
            case "pooler":
              expect(yield* poolerSpec().env(service, new Map(), container)).toMatchObject({
                TENANT_ID: "pooler-dev",
                DEFAULT_POOL_SIZE: "7",
                MAX_CLIENT_CONN: "42",
              });
              break;
            case "realtime":
              expect(yield* realtimeSpec().env(service, new Map(), container)).toMatchObject({
                MAX_HEADER_LENGTH: "8192",
                ERL_AFLAGS: "-proto_dist inet6_tcp",
              });
              break;
            case "storage":
              expect(yield* storageSpec().env(service, new Map(), container)).toMatchObject({
                S3_PROTOCOL_ENABLED: "false",
                VECTOR_ENABLED: "false",
                VECTOR_MAX_BUCKETS: "3",
                VECTOR_MAX_INDEXES: "2",
              });
              break;
            case "studio":
              expect(yield* studioSpec().env(service, new Map(), container)).toMatchObject({
                SUPABASE_PUBLIC_URL: "https://public.example.test",
                OPENAI_API_KEY: "test-openai-key",
              });
              break;
          }
        }
      }
    }).pipe(Effect.provide(layer)),
  );

  it.live(
    "resolves per-function configuration and shared secrets without enabling the inspector",
    () =>
      Effect.gen(function* () {
        const root = yield* createStackConfigProject(
          `project_id = "functions-forwarding"
[edge_runtime]
inspector_port = 59229
[edge_runtime.secrets]
SHARED = "shared-secret"
[functions.hello]
verify_jwt = false
entrypoint = "functions/hello/main.ts"
import_map = "import_map.json"
static_files = ["functions/hello/*.txt"]
[functions.hello.env]
LOCAL = "env(FUNCTION_VALUE)"
[functions.disabled]
enabled = false
`,
          { rootEnv: "FUNCTION_VALUE=function-value\n" },
        );
        const fs = yield* FileSystem.FileSystem;
        yield* fs.writeFileString(
          `${root}/supabase/functions/hello/main.ts`,
          'Deno.serve(() => new Response("hello"));',
        );
        yield* fs.writeFileString(`${root}/supabase/import_map.json`, "{}");
        const config = yield* loadStackConfig(root);
        const services = yield* config.creations("functions-forwarding");
        const functions = services.find((service) => service.service === "functions");
        expect(functions?.config).toMatchObject({
          filesRoot: root,
          env: { SHARED: "shared-secret" },
          functions: {
            hello: {
              verifyJWT: false,
              entrypoint: `${root}/supabase/functions/hello/main.ts`,
              import_map: `${root}/supabase/import_map.json`,
              static_files: [`${root}/supabase/functions/hello/*.txt`],
              env: { LOCAL: "function-value" },
            },
            disabled: { enabled: false },
          },
        });
        expect(functions?.config.inspector).not.toBe(true);
        expect(functions?.endpoints?.inspector?.port).toBe(59229);
      }).pipe(Effect.provide(layer)),
  );
  it.live(
    "decrypts a configured signing secret before deriving service credentials and reopening",
    () =>
      Effect.gen(function* () {
        const plaintext = "test-jwt-secret-with-more-than-32-characters";
        const root = yield* createStackConfigProject(
          `project_id = "encrypted-jwt"
[auth]
jwt_secret = "encrypted:BOsrXIZY2BNTW43BeRhMbfvlOIUjwI7GCyFHxJD/Ik+UQ4mqkgVl2+61WWhEf3+8SEDngaEMZnSWajCMCInbHJbRnH+C1xgcAZlWKR0qLcHanvkM+zDKWxcQgMbN5AmOqwn3olCjpHbqkSzoyPri015szpcZMp5JKGmUsw6KEwTFE7LyQwRlTbqlVn7u"
`,
          {
            rootEnv:
              "DOTENV_PRIVATE_KEY=7fd7210cef8f331ee8c55897996aaaafd853a2b20a4dc73d6d75759f65d2a7eb\n",
          },
        );
        const config = yield* loadStackConfig(root);
        expect(Redacted.value(config.jwtSecret)).toBe(plaintext);
        const services = yield* config.creations("encrypted-jwt", {
          jwtSecret: Redacted.make(plaintext),
        });
        expect(services.find((service) => service.service === "auth")?.config.jwtSecret).toBe(
          plaintext,
        );
      }).pipe(Effect.provide(layer)),
  );

  it.live("reopens with an empty configured JWT secret and omits an empty database root key", () =>
    Effect.gen(function* () {
      const root = yield* createStackConfigProject(`project_id = "empty-secrets"
[auth]
jwt_secret = ""
[db]
root_key = ""
`);
      const config = yield* loadStackConfig(root);
      const creations = yield* config.creations("empty-secrets", { jwtSecret: config.jwtSecret });
      const database = creations.find((creation) => creation.service === "database");
      expect(database).toBeDefined();
      expect(database?.config.rootKey).toBeUndefined();
    }).pipe(Effect.provide(layer)),
  );

  it.live("forwards Auth policies, providers and custom SMTP ahead of local mail", () =>
    Effect.gen(function* () {
      const root = yield* createStackConfigProject(
        `project_id = "auth-forwarding"
[auth]
additional_redirect_urls = ["https://app.example.test/callback"]
enable_refresh_token_rotation = false
refresh_token_reuse_interval = 15
enable_manual_linking = true
enable_anonymous_sign_ins = true
minimum_password_length = 12
password_requirements = "letters_digits"
jwt_issuer = "https://issuer.example.test"
[auth.rate_limit]
email_sent = 55
sms_sent = 44
sign_in_sign_ups = 33
[auth.email]
enable_confirmations = true
double_confirm_changes = false
secure_password_change = true
otp_length = 8
otp_expiry = 120
max_frequency = "10s"
[auth.email.smtp]
enabled = true
host = "smtp.example.test"
port = 2525
user = "test-user"
pass = "env(SMTP_SECRET)"
admin_email = "admin@example.test"
sender_name = "Custom sender"
[auth.email.template.confirmation]
subject = "Confirm your account"
[auth.email.notification.password_changed]
enabled = true
subject = "Password changed"
[auth.sms]
enable_signup = true
otp_length = 7
otp_expiry = 180
[auth.sms.test_otp]
"12345678901" = "1234567"
[auth.sms.twilio]
enabled = true
account_sid = "AC123"
auth_token = "env(SMS_SECRET)"
message_service_sid = "MG123"
content_sid = "HX123"
[auth.captcha]
enabled = true
provider = "hcaptcha"
secret = "env(CAPTCHA_SECRET)"
[auth.hook.custom_access_token]
enabled = true
uri = "pg-functions://postgres/public/custom_access_token"
[auth.mfa.totp]
enroll_enabled = true
verify_enabled = true
[auth.mfa.phone]
enroll_enabled = true
verify_enabled = true
otp_length = 7
max_frequency = "10s"
[auth.sessions]
timebox = "24h"
inactivity_timeout = "1h"
[auth.external.github]
enabled = true
client_id = "github-client"
secret = "env(GITHUB_SECRET)"
[auth.web3.solana]
enabled = true
[auth.oauth_server]
enabled = true
authorization_url_path = "/oauth/consent"
allow_dynamic_registration = true
`,
        {
          rootEnv:
            "SMTP_SECRET=smtp-secret\nSMS_SECRET=sms-secret\nCAPTCHA_SECRET=captcha-secret\nGITHUB_SECRET=github-secret\n",
        },
      );
      const config = yield* loadStackConfig(root);
      const services = yield* config.creations("auth-forwarding");
      const auth = services.find((service) => service.service === "auth");
      expect(auth).toBeDefined();
      if (auth === undefined) return;
      const decoded = yield* Schema.decodeEffect(ServiceCreation)(auth);
      expect(decoded).toEqual(auth);
      if (decoded.service !== "auth") return;
      expect(decoded.config.settings?.email?.template.confirmation?.subject).toBe(
        "Confirm your account",
      );
      expect(decoded.config.settings?.email?.notification.password_changed?.subject).toBe(
        "Password changed",
      );
      expect(decoded.config.smtp).toMatchObject({
        host: "smtp.example.test",
        port: 2525,
        adminEmail: "admin@example.test",
      });
      const env = yield* authSpec().env(
        {
          ...auth,
          config: {
            ...auth.config,
            smtpUrl: "smtp://127.0.0.1:1025",
            externalApiUrl: "http://localhost:54321/auth/v1",
          },
        },
        new Map(),
        false,
      );
      expect(env).toMatchObject({
        GOTRUE_URI_ALLOW_LIST: "https://app.example.test/callback",
        GOTRUE_SECURITY_REFRESH_TOKEN_ROTATION_ENABLED: "false",
        GOTRUE_SECURITY_REFRESH_TOKEN_REUSE_INTERVAL: "15",
        GOTRUE_SECURITY_MANUAL_LINKING_ENABLED: "true",
        GOTRUE_EXTERNAL_ANONYMOUS_USERS_ENABLED: "true",
        GOTRUE_PASSWORD_MIN_LENGTH: "12",
        GOTRUE_PASSWORD_REQUIRED_CHARACTERS:
          "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ:0123456789",
        GOTRUE_JWT_ISSUER: "https://issuer.example.test",
        GOTRUE_RATE_LIMIT_EMAIL_SENT: "55",
        GOTRUE_RATE_LIMIT_SMS_SENT: "44",
        GOTRUE_RATE_LIMIT_OTP: "33",
        GOTRUE_MAILER_AUTOCONFIRM: "false",
        GOTRUE_MAILER_SECURE_EMAIL_CHANGE_ENABLED: "false",
        GOTRUE_SECURITY_UPDATE_PASSWORD_REQUIRE_REAUTHENTICATION: "true",
        GOTRUE_MAILER_OTP_LENGTH: "8",
        GOTRUE_MAILER_OTP_EXP: "120",
        GOTRUE_SMTP_MAX_FREQUENCY: "10s",
        GOTRUE_SMTP_HOST: "smtp.example.test",
        GOTRUE_SMTP_PORT: "2525",
        GOTRUE_SMTP_PASS: "smtp-secret",
        GOTRUE_SMTP_SENDER_NAME: "Custom sender",
        GOTRUE_MAILER_SUBJECTS_CONFIRMATION: "Confirm your account",
        GOTRUE_MAILER_NOTIFICATIONS_PASSWORD_CHANGED_ENABLED: "true",
        GOTRUE_MAILER_SUBJECTS_PASSWORD_CHANGED_NOTIFICATION: "Password changed",
        GOTRUE_SMS_OTP_LENGTH: "7",
        GOTRUE_SMS_OTP_EXP: "180",
        GOTRUE_SMS_TEST_OTP: "12345678901:1234567",
        GOTRUE_SMS_PROVIDER: "twilio",
        GOTRUE_SMS_TWILIO_AUTH_TOKEN: "sms-secret",
        GOTRUE_SMS_TWILIO_CONTENT_SID: "HX123",
        GOTRUE_SECURITY_CAPTCHA_SECRET: "captcha-secret",
        GOTRUE_HOOK_CUSTOM_ACCESS_TOKEN_ENABLED: "true",
        GOTRUE_HOOK_CUSTOM_ACCESS_TOKEN_URI: "pg-functions://postgres/public/custom_access_token",
        GOTRUE_MFA_TOTP_ENROLL_ENABLED: "true",
        GOTRUE_MFA_PHONE_OTP_LENGTH: "7",
        GOTRUE_MFA_PHONE_MAX_FREQUENCY: "10s",
        GOTRUE_SESSIONS_TIMEBOX: "24h",
        GOTRUE_SESSIONS_INACTIVITY_TIMEOUT: "1h",
        GOTRUE_EXTERNAL_GITHUB_CLIENT_ID: "github-client",
        GOTRUE_EXTERNAL_GITHUB_SECRET: "github-secret",
        GOTRUE_EXTERNAL_GITHUB_REDIRECT_URI: "http://localhost:54321/auth/v1/callback",
        GOTRUE_EXTERNAL_WEB3_SOLANA_ENABLED: "true",
        GOTRUE_OAUTH_SERVER_AUTHORIZATION_PATH: "/oauth/consent",
      });
    }).pipe(Effect.provide(layer)),
  );
});
