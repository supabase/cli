import { Effect, Schema } from "effect";
import { stringEnum } from "./lib/schema.ts";

const links = [
  {
    name: "Supabase Realtime",
    link: "https://supabase.com/docs/guides/realtime",
  },
];

const tags = ["realtime"];
const defaultRealtime = {};
const defaultEnabled = true;
const defaultIpVersion = "IPv4";
const defaultMaxHeaderLength = 4096;

export const realtime = Schema.Struct({
  enabled: Schema.Boolean.annotate({
    default: defaultEnabled,
    description: "Enable the local Realtime service.",
    tags,
    links,
  }).pipe(Schema.withDecodingDefaultKey(Effect.succeed(defaultEnabled))),
  ip_version: stringEnum(["IPv4", "IPv6"], {
    default: defaultIpVersion,
    description: "Bind realtime via either IPv4 or IPv6.",
    tags,
    links: [
      {
        name: "Supabase Realtime Configuration",
        link: "https://supabase.com/docs/guides/realtime/self-hosting",
      },
    ],
  }).pipe(Schema.withDecodingDefaultKey(Effect.succeed(defaultIpVersion))),
  max_header_length: Schema.Number.annotate({
    default: defaultMaxHeaderLength,
    description: "Maximum length of the HTTP header.",
    tags,
  }).pipe(Schema.withDecodingDefaultKey(Effect.succeed(defaultMaxHeaderLength))),
}).pipe(Schema.withDecodingDefaultKey(Effect.succeed({ ...defaultRealtime })));
