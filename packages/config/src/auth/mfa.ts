import { s } from "jsonv-ts";

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

export const mfa = s
  .strictObject({
    totp: s
      .strictObject({
        enroll_enabled: s.boolean({
          default: true,
          description: "Allow/disallow TOTP enrollment for users.",
          tags,
          links: [links.totp],
        }),
        verify_enabled: s.boolean({
          default: true,
          description: "Allow/disallow TOTP verification for users.",
          tags,
          links: [links.totp],
        }),
      })
      .partial(),
    phone: s
      .strictObject({
        enroll_enabled: s.boolean({
          default: false,
          description: "Allow/disallow phone enrollment for users.",
          tags,
          links: [links.phone],
        }),
        verify_enabled: s.boolean({
          default: false,
          description: "Allow/disallow phone verification for users.",
          tags,
          links: [links.phone],
        }),
        otp_length: s.number({
          default: 6,
          description: "The length of the OTP code.",
          tags,
          links: [links.phone],
        }),
        template: s.string({
          default: "Your code is {{ .Code }}",
          description: "The template to use for the phone message.",
          tags,
          links: [links.phone],
        }),
        max_frequency: s.string({
          default: "60s",
          description: "The maximum frequency of the phone messages.",
          tags,
          links: [links.phone],
        }),
      })
      .partial(),
    max_enrolled_factors: s.number({
      default: 10,
      description: "The maximum number of MFA factors a user can enroll in.",
      tags,
      links: [links.mfa],
    }),
  })
  .partial();
