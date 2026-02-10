import { s } from "jsonv-ts";

const links = [
  {
    name: "Supabase Realtime",
    link: "https://supabase.com/docs/guides/realtime",
  },
];

const tags = ["realtime"];

export const realtime = s
  .strictObject({
    enabled: s.boolean({
      default: true,
      description: "Enable the local Realtime service.",
      tags,
      links,
    }),
    ip_version: s.string({
      enum: ["IPv4", "IPv6"],
      default: "IPv4",
      description: "Bind realtime via either IPv4 or IPv6.",
      tags,
      links: [
        {
          name: "Supabase Realtime Configuration",
          link: "https://supabase.com/docs/guides/realtime/self-hosting",
        },
      ],
    }),
    max_header_length: s.number({
      default: 4096,
      description: "Maximum length of the HTTP header.",
      tags,
    }),
  })
  .partial();
