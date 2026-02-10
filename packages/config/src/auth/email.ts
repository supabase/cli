import { s } from "jsonv-ts";
import { env } from "../lib/env";

const tags = ["auth"];

const links = {
  auth: {
    name: "Auth Server configuration",
    link: "https://supabase.com/docs/reference/auth",
  },
};

const createTemplateSchema = (name: string, defaultSubject: string) =>
  s
    .strictObject({
      subject: s.string({
        default: defaultSubject,
        description: `The subject of the ${name} email.`,
      }),
      content_path: s.string({
        description: `The path to the content of the ${name} email.`,
      }),
    })
    .partial();

export const email = s
  .strictObject({
    enable_signup: s.boolean({
      default: true,
      description: "Allow/disallow new user signups via email to your project.",
      tags,
      links: [links.auth],
    }),
    double_confirm_changes: s.boolean({
      default: true,
      description:
        "If enabled, a user will be required to confirm any email change on both the old, and new email addresses. If disabled, only the new email is required to confirm.",
      tags,
      links: [links.auth],
    }),
    enable_confirmations: s.boolean({
      default: false,
      description: "If enabled, users need to confirm their email address before signing in.",
      tags,
      links: [links.auth],
    }),
    secure_password_change: s.boolean({
      default: false,
      description:
        "If enabled, users will need to reauthenticate or have logged in recently to change their password.",
      tags,
      links: [links.auth],
    }),
    max_frequency: s.string({
      default: "1s",
      description:
        "Controls the minimum amount of time that must pass before sending another signup confirmation or password reset email.",
      tags,
      links: [links.auth],
    }),
    smtp: s
      .strictObject({
        host: s.string({
          default: "inbucket",
          description: "Hostname or IP address of the SMTP server.",
        }),
        port: s.number({
          default: 2500,
          description: "Port number of the SMTP server.",
        }),
        user: s.string({
          description: "Username for authenticating with the SMTP server.",
        }),
        pass: env({
          secret: true,
          description: "Password for authenticating with the SMTP server.",
        }),
        admin_email: s.string({
          default: "admin@email.com",
          description: "Email used as the sender for emails sent from the application.",
        }),
        sender_name: s.string({
          description: "Display name used as the sender for emails sent from the application.",
        }),
      })
      .partial(),
    template: s
      .strictObject({
        invite: createTemplateSchema("invite", "You have been invited"),
        confirmation: createTemplateSchema("confirmation", "Confirm Your Signup"),
        recovery: createTemplateSchema("recovery", "Reset Your Password"),
        magic_link: createTemplateSchema("magic link", "Your Magic Link"),
        email_change: createTemplateSchema("email change", "Confirm Email Change"),
      })
      .partial(),
  })
  .partial();
