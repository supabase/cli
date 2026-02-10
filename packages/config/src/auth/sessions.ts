import { s } from "jsonv-ts";

const tags = ["auth"];

const links = [
  {
    name: "User sessions",
    link: "https://supabase.com/docs/guides/auth/sessions",
  },
];

export const sessions = s
  .strictObject({
    timebox: s.string({
      description: "The timebox for the user session.",
      tags,
      links,
    }),
    inactivity_timeout: s.string({
      description: "The inactivity timeout for the user session.",
      tags,
      links,
    }),
  })
  .partial();
