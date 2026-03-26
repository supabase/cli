import { Schema } from "effect";

const tags = ["auth"];

const links = {
  mfa: {
    name: "Multi-Factor Authentication",
    link: "https://supabase.com/docs/guides/auth/auth-mfa",
  },
  totp: {
    name: "Multi-Factor Authentication (TOTP)",
    link: "https://supabase.com/docs/guides/auth/auth-mfa/totp",
  },
  phone: {
    name: "Multi-Factor Authentication (Phone)",
    link: "https://supabase.com/docs/guides/auth/auth-mfa/phone",
  },
};

const defaultMfa = {};
const defaultTotp = {};
const defaultTotpEnrollEnabled = false;
const defaultTotpVerifyEnabled = false;
const defaultPhone = {};
const defaultPhoneEnrollEnabled = false;
const defaultPhoneVerifyEnabled = false;
const defaultPhoneOtpLength = 6;
const defaultPhoneTemplate = "Your code is {{ .Code }}";
const defaultPhoneMaxFrequency = "5s";
const defaultWebAuthn = {};
const defaultWebAuthnEnrollEnabled = false;
const defaultWebAuthnVerifyEnabled = false;
const defaultMaxEnrolledFactors = 10;

export const mfa = Schema.Struct({
  totp: Schema.Struct({
    enroll_enabled: Schema.Boolean.annotate({
      default: defaultTotpEnrollEnabled,
      description: "Allow/disallow TOTP enrollment for users.",
      tags,
      links: [links.totp],
    }).pipe(Schema.withDecodingDefaultKey(() => defaultTotpEnrollEnabled)),
    verify_enabled: Schema.Boolean.annotate({
      default: defaultTotpVerifyEnabled,
      description: "Allow/disallow TOTP verification for users.",
      tags,
      links: [links.totp],
    }).pipe(Schema.withDecodingDefaultKey(() => defaultTotpVerifyEnabled)),
  }).pipe(Schema.withDecodingDefaultKey(() => ({ ...defaultTotp }))),
  phone: Schema.Struct({
    enroll_enabled: Schema.Boolean.annotate({
      default: defaultPhoneEnrollEnabled,
      description: "Allow/disallow phone enrollment for users.",
      tags,
      links: [links.phone],
    }).pipe(Schema.withDecodingDefaultKey(() => defaultPhoneEnrollEnabled)),
    verify_enabled: Schema.Boolean.annotate({
      default: defaultPhoneVerifyEnabled,
      description: "Allow/disallow phone verification for users.",
      tags,
      links: [links.phone],
    }).pipe(Schema.withDecodingDefaultKey(() => defaultPhoneVerifyEnabled)),
    otp_length: Schema.Number.annotate({
      default: defaultPhoneOtpLength,
      description: "The length of the OTP code.",
      tags,
      links: [links.phone],
    }).pipe(Schema.withDecodingDefaultKey(() => defaultPhoneOtpLength)),
    template: Schema.String.annotate({
      default: defaultPhoneTemplate,
      description: "The template to use for the phone message.",
      tags,
      links: [links.phone],
    }).pipe(Schema.withDecodingDefaultKey(() => defaultPhoneTemplate)),
    max_frequency: Schema.String.annotate({
      default: defaultPhoneMaxFrequency,
      description: "The maximum frequency of the phone messages.",
      tags,
      links: [links.phone],
    }).pipe(Schema.withDecodingDefaultKey(() => defaultPhoneMaxFrequency)),
  }).pipe(Schema.withDecodingDefaultKey(() => ({ ...defaultPhone }))),
  web_authn: Schema.Struct({
    enroll_enabled: Schema.Boolean.annotate({
      default: defaultWebAuthnEnrollEnabled,
      description: "Allow/disallow WebAuthn enrollment for users.",
      tags,
      links: [links.mfa],
    }).pipe(Schema.withDecodingDefaultKey(() => defaultWebAuthnEnrollEnabled)),
    verify_enabled: Schema.Boolean.annotate({
      default: defaultWebAuthnVerifyEnabled,
      description: "Allow/disallow WebAuthn verification for users.",
      tags,
      links: [links.mfa],
    }).pipe(Schema.withDecodingDefaultKey(() => defaultWebAuthnVerifyEnabled)),
  }).pipe(Schema.withDecodingDefaultKey(() => ({ ...defaultWebAuthn }))),
  max_enrolled_factors: Schema.Number.annotate({
    default: defaultMaxEnrolledFactors,
    description: "The maximum number of MFA factors a user can enroll in.",
    tags,
    links: [links.mfa],
  }).pipe(Schema.withDecodingDefaultKey(() => defaultMaxEnrolledFactors)),
}).pipe(Schema.withDecodingDefaultKey(() => ({ ...defaultMfa })));
