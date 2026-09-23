import type { CliConfig } from "@supabase/config";
import type { ServiceCreation } from "@supabase/stack/effect";
import { Effect } from "effect";
import { passwordRequirementsToChar } from "./password-requirements.ts";

type AuthConfig = Extract<ServiceCreation, { readonly service: "auth" }>["config"];

/** Maps resolved CLI authentication policy to the Auth service. */
export const resolveAuthConfig = Effect.fn("StackAuthConfig.resolve")(
  (auth: CliConfig["auth"], localSmtp: CliConfig["local_smtp"]): Effect.Effect<AuthConfig> =>
    Effect.succeed({
      databaseUrl: "postgresql://placeholder",
      siteUrl: auth.site_url,
      jwtExpiry: auth.jwt_expiry,
      disableSignup: !auth.enable_signup,
      ...(localSmtp.admin_email === undefined ? {} : { smtpAdminEmail: localSmtp.admin_email }),
      ...(localSmtp.sender_name === undefined ? {} : { smtpSenderName: localSmtp.sender_name }),
      settings: {
        additionalRedirectUrls: auth.additional_redirect_urls.join(","),
        enableRefreshTokenRotation: auth.enable_refresh_token_rotation,
        refreshTokenReuseInterval: auth.refresh_token_reuse_interval,
        enableManualLinking: auth.enable_manual_linking,
        enableAnonymousSignIns: auth.enable_anonymous_sign_ins,
        minimumPasswordLength: auth.minimum_password_length,
        passwordRequirements: passwordRequirementsToChar(auth.password_requirements),
        ...(auth.jwt_issuer === undefined ? {} : { jwtIssuer: auth.jwt_issuer }),
        rateLimit: auth.rate_limit,
        email: {
          enable_signup: auth.email.enable_signup,
          double_confirm_changes: auth.email.double_confirm_changes,
          enable_confirmations: auth.email.enable_confirmations,
          secure_password_change: auth.email.secure_password_change,
          max_frequency: auth.email.max_frequency,
          otp_length: auth.email.otp_length,
          otp_expiry: auth.email.otp_expiry,
          template: Object.fromEntries(
            Object.entries(auth.email.template).map(([name, template]) => [
              name,
              { subject: template.subject },
            ]),
          ),
          notification: Object.fromEntries(
            Object.entries(auth.email.notification).map(([name, notification]) => [
              name,
              { enabled: notification.enabled, subject: notification.subject },
            ]),
          ),
        },
        sms: auth.sms,
        ...(auth.captcha === undefined ? {} : { captcha: auth.captcha }),
        hooks: auth.hook,
        mfa: auth.mfa,
        ...(auth.sessions === undefined ? {} : { sessions: auth.sessions }),
        external: Object.fromEntries(
          Object.entries(auth.external).flatMap(([name, provider]) =>
            provider === undefined ? [] : [[name, provider]],
          ),
        ),
        web3: auth.web3,
        oauthServer: auth.oauth_server,
      },
      ...(auth.email.smtp?.enabled !== true
        ? {}
        : {
            smtp: {
              host: auth.email.smtp.host ?? "",
              port: auth.email.smtp.port ?? 587,
              user: auth.email.smtp.user ?? "",
              pass: auth.email.smtp.pass ?? "",
              adminEmail: auth.email.smtp.admin_email ?? "",
              ...(auth.email.smtp.sender_name === undefined
                ? {}
                : { senderName: auth.email.smtp.sender_name }),
            },
          }),
    }),
);
