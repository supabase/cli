import { s } from "jsonv-ts";

const tags = ["edge-functions"];

export const edge_runtime = s
  .strictObject({
    enabled: s.boolean({
      default: true,
      description: "Enable the local Edge Runtime service.",
      tags,
    }),
    policy: s.string({
      enum: ["oneshot", "per_worker"],
      default: "oneshot",
      description:
        "Configure the supported request policy. Use `oneshot` for hot reload, or `per_worker` for load testing.",
      tags,
    }),
    inspector_port: s.number({
      default: 8083,
      description: "Port to run the Edge Functions inspector on.",
      tags,
    }),
  })
  .partial();
