import { s } from "jsonv-ts";

const links = [
  {
    name: "Storage server configuration",
    link: "https://supabase.com/docs/guides/self-hosting/storage/config",
  },
];

const tags = ["storage"];

const bucketSchema = s
  .strictObject({
    public: s.boolean({
      default: false,
      description: "Enable public access to the bucket.",
    }),
    file_size_limit: s.string({
      default: "50MiB",
      description: "The maximum file size allowed for the bucket.",
      examples: ["5MB", "500KB"],
      tags,
      links,
    }),
    allowed_mime_types: s.array(
      s.string({
        description: "A MIME type allowed for the bucket.",
        tags,
      }),
      {
        examples: [["image/png", "image/jpeg"]],
        description: "The list of allowed MIME types for the bucket.",
        tags,
      },
    ),
    objects_path: s.string({
      description: "The path to the objects in the bucket.",
      tags,
    }),
  })
  .partial();

export const storage = s
  .strictObject({
    enabled: s.boolean({
      default: true,
      description: "Enable the local Storage service.",
      tags,
      links,
    }),
    file_size_limit: s.string({
      default: "50MiB",
      description: "The maximum file size allowed.",
      examples: ["5MB", "500KB"],
      tags,
      links,
    }),
    image_transformation: s
      .strictObject({
        enabled: s.boolean({
          default: true,
          description: "Enable image transformation.",
          tags,
          links,
        }),
      })
      .partial(),
    buckets: s.record(bucketSchema, {
      description: "Storage buckets configuration.",
      tags,
    }),
  })
  .partial();
