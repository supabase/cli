import { Schema } from "effect";
import { secret } from "../lib/env.ts";

const tags = ["auth"];

const links = {
  auth: {
    name: "Auth Server configuration",
    link: "https://supabase.com/docs/reference/auth",
  },
};

const defaultEmail = {};
const defaultEnableSignup = true;
const defaultDoubleConfirmChanges = true;
const defaultEnableConfirmations = false;
const defaultSecurePasswordChange = false;
const defaultMaxFrequency = "1s";
const defaultOtpLength = 6;
const defaultOtpExpiry = 3600;
const defaultTemplate = {};
const defaultNotification = {};
const defaultSmtpEnabled = false;
const defaultNotificationEnabled = false;
const defaultSubject = "";
const defaultContentPath = "";

const templateNamePattern = new RegExp(
  "^(invite|confirmation|recovery|magic_link|email_change|reauthentication)$",
);

const notificationNamePattern = new RegExp(
  "^(password_changed|email_changed|phone_changed|identity_linked|identity_unlinked|mfa_factor_enrolled|mfa_factor_unenrolled)$",
);

const templateName = Schema.String.check(Schema.isPattern(templateNamePattern));
const notificationName = Schema.String.check(Schema.isPattern(notificationNamePattern));

function requiredWhenEnabled<
  T extends Record<string, string | number | boolean | undefined> & { enabled: boolean },
>(path: string, predicate: (value: T) => boolean, message: string) {
  return Schema.makeFilter((value: T) => {
    if (!value.enabled || predicate(value)) {
      return undefined;
    }

    return {
      path: [path],
      message,
    };
  });
}

const template = Schema.Struct({
  subject: Schema.String.annotate({
    default: defaultSubject,
    description: "Subject line for the email template.",
  }).pipe(Schema.withDecodingDefaultKey(() => defaultSubject)),
  content_path: Schema.String.annotate({
    default: defaultContentPath,
    description: "Path to the HTML template.",
  }).pipe(Schema.withDecodingDefaultKey(() => defaultContentPath)),
}).pipe(Schema.withDecodingDefault(() => ({})));

const notification = Schema.Struct({
  enabled: Schema.Boolean.annotate({
    default: defaultNotificationEnabled,
    description: "Enable the notification email.",
  }).pipe(Schema.withDecodingDefaultKey(() => defaultNotificationEnabled)),
  subject: Schema.String.annotate({
    default: defaultSubject,
    description: "Subject line for the notification email.",
  }).pipe(Schema.withDecodingDefaultKey(() => defaultSubject)),
  content_path: Schema.String.annotate({
    default: defaultContentPath,
    description: "Path to the HTML notification template.",
  }).pipe(Schema.withDecodingDefaultKey(() => defaultContentPath)),
}).pipe(Schema.withDecodingDefault(() => ({})));

export const email = Schema.Struct({
  enable_signup: Schema.Boolean.annotate({
    default: defaultEnableSignup,
    description: "Allow/disallow new user signups via email to your project.",
    tags,
    links: [links.auth],
  }).pipe(Schema.withDecodingDefaultKey(() => defaultEnableSignup)),
  double_confirm_changes: Schema.Boolean.annotate({
    default: defaultDoubleConfirmChanges,
    description:
      "If enabled, a user will be required to confirm any email change on both the old and new email addresses.",
    tags,
    links: [links.auth],
  }).pipe(Schema.withDecodingDefaultKey(() => defaultDoubleConfirmChanges)),
  enable_confirmations: Schema.Boolean.annotate({
    default: defaultEnableConfirmations,
    description: "If enabled, users need to confirm their email address before signing in.",
    tags,
    links: [links.auth],
  }).pipe(Schema.withDecodingDefaultKey(() => defaultEnableConfirmations)),
  secure_password_change: Schema.Boolean.annotate({
    default: defaultSecurePasswordChange,
    description:
      "If enabled, users will need to reauthenticate or have logged in recently to change their password.",
    tags,
    links: [links.auth],
  }).pipe(Schema.withDecodingDefaultKey(() => defaultSecurePasswordChange)),
  max_frequency: Schema.String.annotate({
    default: defaultMaxFrequency,
    description:
      "Controls the minimum amount of time that must pass before sending another signup confirmation or password reset email.",
    tags,
    links: [links.auth],
  }).pipe(Schema.withDecodingDefaultKey(() => defaultMaxFrequency)),
  otp_length: Schema.Number.annotate({
    default: defaultOtpLength,
    description: "Number of characters used in the email OTP.",
    tags,
    links: [links.auth],
  }).pipe(Schema.withDecodingDefaultKey(() => defaultOtpLength)),
  otp_expiry: Schema.Number.annotate({
    default: defaultOtpExpiry,
    description: "Number of seconds before the email OTP expires.",
    tags,
    links: [links.auth],
  }).pipe(Schema.withDecodingDefaultKey(() => defaultOtpExpiry)),
  smtp: Schema.optionalKey(
    Schema.Struct({
      enabled: Schema.Boolean.annotate({
        default: defaultSmtpEnabled,
        description: "Enable SMTP for email delivery.",
      }).pipe(Schema.withDecodingDefaultKey(() => defaultSmtpEnabled)),
      host: Schema.optionalKey(
        Schema.String.annotate({
          description: "Hostname or IP address of the SMTP server.",
        }),
      ),
      port: Schema.optionalKey(
        Schema.Number.annotate({
          description: "Port number of the SMTP server.",
        }),
      ),
      user: Schema.optionalKey(
        Schema.String.annotate({
          description: "Username for authenticating with the SMTP server.",
        }),
      ),
      pass: Schema.optionalKey(
        secret({
          description: "Password for authenticating with the SMTP server.",
        }),
      ),
      admin_email: Schema.optionalKey(
        Schema.String.annotate({
          description: "Email used as the sender for emails sent from the application.",
        }),
      ),
      sender_name: Schema.optionalKey(
        Schema.String.annotate({
          description: "Display name used as the sender for emails sent from the application.",
        }),
      ),
    })
      .check(
        requiredWhenEnabled(
          "host",
          (value) => value.host !== undefined && value.host !== "",
          "Missing required field in config: auth.email.smtp.host",
        ),
        requiredWhenEnabled(
          "port",
          (value) => value.port !== undefined,
          "Missing required field in config: auth.email.smtp.port",
        ),
        requiredWhenEnabled(
          "user",
          (value) => value.user !== undefined && value.user !== "",
          "Missing required field in config: auth.email.smtp.user",
        ),
        requiredWhenEnabled(
          "pass",
          (value) => value.pass !== undefined && value.pass !== "",
          "Missing required field in config: auth.email.smtp.pass",
        ),
        requiredWhenEnabled(
          "admin_email",
          (value) => value.admin_email !== undefined && value.admin_email !== "",
          "Missing required field in config: auth.email.smtp.admin_email",
        ),
      )
      .pipe(Schema.withDecodingDefaultKey(() => ({}))),
  ),
  template: Schema.Record(templateName, template)
    .annotate({
      default: defaultTemplate,
      description: "Custom email template configuration.",
      tags,
      links: [links.auth],
    })
    .pipe(Schema.withDecodingDefault(() => ({ ...defaultTemplate }))),
  notification: Schema.Record(notificationName, notification)
    .annotate({
      default: defaultNotification,
      description: "Notification email configuration.",
      tags,
      links: [links.auth],
    })
    .pipe(Schema.withDecodingDefault(() => ({ ...defaultNotification }))),
}).pipe(Schema.withDecodingDefaultKey(() => ({ ...defaultEmail })));
