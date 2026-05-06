import { Schema } from "effect";

const links = [
  {
    name: "Storage server configuration",
    link: "https://supabase.com/docs/guides/self-hosting/storage/config",
  },
];

const tags = ["storage"];
const defaultStorage = {};
const defaultEnabled = true;
const defaultFileSizeLimit = "50MiB";
const defaultBucketPublic = false;
const defaultBucketFileSizeLimit = "50MiB";
const defaultBucketAllowedMimeTypes: string[] = [];
const defaultBucketObjectsPath = "";
const defaultS3Protocol = {};
const defaultS3ProtocolEnabled = true;
const defaultAnalytics = {};
const defaultAnalyticsEnabled = false;
const defaultMaxNamespaces = 5;
const defaultMaxTables = 10;
const defaultMaxCatalogs = 2;
const defaultAnalyticsBuckets = {};
const defaultVector = {};
const defaultVectorEnabled = false;
const defaultMaxBuckets = 10;
const defaultMaxIndexes = 5;
const defaultVectorBuckets = {};

const bucketSchema = Schema.Struct({
  public: Schema.Boolean.annotate({
    default: defaultBucketPublic,
    description: "Enable public access to the bucket.",
  }).pipe(Schema.withDecodingDefaultKey(() => defaultBucketPublic)),
  file_size_limit: Schema.String.annotate({
    default: defaultBucketFileSizeLimit,
    description: "The maximum file size allowed for the bucket.",
    examples: ["5MB", "500KB"],
    tags,
    links,
  }).pipe(Schema.withDecodingDefaultKey(() => defaultBucketFileSizeLimit)),
  allowed_mime_types: Schema.Array(
    Schema.String.annotate({
      description: "A MIME type allowed for the bucket.",
      tags,
    }),
  )
    .annotate({
      default: defaultBucketAllowedMimeTypes,
      description: "The list of allowed MIME types for the bucket.",
      tags,
    })
    .pipe(Schema.withDecodingDefaultKey(() => [...defaultBucketAllowedMimeTypes])),
  objects_path: Schema.String.annotate({
    default: defaultBucketObjectsPath,
    description: "The path to the objects in the bucket.",
    tags,
  }).pipe(Schema.withDecodingDefaultKey(() => defaultBucketObjectsPath)),
}).pipe(Schema.withDecodingDefault(() => ({})));

export const storage = Schema.Struct({
  enabled: Schema.Boolean.annotate({
    default: defaultEnabled,
    description: "Enable the local Storage service.",
    tags,
    links,
  }).pipe(Schema.withDecodingDefaultKey(() => defaultEnabled)),
  file_size_limit: Schema.String.annotate({
    default: defaultFileSizeLimit,
    description: "The maximum file size allowed.",
    examples: ["5MB", "500KB"],
    tags,
    links,
  }).pipe(Schema.withDecodingDefaultKey(() => defaultFileSizeLimit)),
  image_transformation: Schema.optionalKey(
    Schema.Struct({
      enabled: Schema.Boolean.annotate({
        default: false,
        description: "Enable image transformation.",
        tags,
        links,
      }).pipe(Schema.withDecodingDefaultKey(() => false)),
    }).pipe(Schema.withDecodingDefaultKey(() => ({}))),
  ),
  buckets: Schema.optionalKey(
    Schema.Record(Schema.String, bucketSchema).annotate({
      description: "Storage buckets configuration.",
      tags,
    }),
  ),
  s3_protocol: Schema.Struct({
    enabled: Schema.Boolean.annotate({
      default: defaultS3ProtocolEnabled,
      description: "Allow connections via S3 compatible clients.",
      tags,
      links,
    }).pipe(Schema.withDecodingDefaultKey(() => defaultS3ProtocolEnabled)),
  }).pipe(Schema.withDecodingDefaultKey(() => ({ ...defaultS3Protocol }))),
  analytics: Schema.Struct({
    enabled: Schema.Boolean.annotate({
      default: defaultAnalyticsEnabled,
      description: "Enable analytics buckets.",
      tags,
      links,
    }).pipe(Schema.withDecodingDefaultKey(() => defaultAnalyticsEnabled)),
    max_namespaces: Schema.Number.annotate({
      default: defaultMaxNamespaces,
      description: "Maximum number of analytics namespaces.",
      tags,
      links,
    }).pipe(Schema.withDecodingDefaultKey(() => defaultMaxNamespaces)),
    max_tables: Schema.Number.annotate({
      default: defaultMaxTables,
      description: "Maximum number of analytics tables.",
      tags,
      links,
    }).pipe(Schema.withDecodingDefaultKey(() => defaultMaxTables)),
    max_catalogs: Schema.Number.annotate({
      default: defaultMaxCatalogs,
      description: "Maximum number of analytics catalogs.",
      tags,
      links,
    }).pipe(Schema.withDecodingDefaultKey(() => defaultMaxCatalogs)),
    buckets: Schema.Record(
      Schema.String,
      Schema.Struct({}).pipe(Schema.withDecodingDefault(() => ({ ...defaultAnalyticsBuckets }))),
    )
      .annotate({
        default: defaultAnalyticsBuckets,
        description: "Analytics bucket configuration.",
        tags,
      })
      .pipe(Schema.withDecodingDefault(() => ({ ...defaultAnalyticsBuckets }))),
  }).pipe(Schema.withDecodingDefaultKey(() => ({ ...defaultAnalytics }))),
  vector: Schema.Struct({
    enabled: Schema.Boolean.annotate({
      default: defaultVectorEnabled,
      description: "Enable vector buckets.",
      tags,
      links,
    }).pipe(Schema.withDecodingDefaultKey(() => defaultVectorEnabled)),
    max_buckets: Schema.Number.annotate({
      default: defaultMaxBuckets,
      description: "Maximum number of vector buckets.",
      tags,
      links,
    }).pipe(Schema.withDecodingDefaultKey(() => defaultMaxBuckets)),
    max_indexes: Schema.Number.annotate({
      default: defaultMaxIndexes,
      description: "Maximum number of vector indexes.",
      tags,
      links,
    }).pipe(Schema.withDecodingDefaultKey(() => defaultMaxIndexes)),
    buckets: Schema.Record(
      Schema.String,
      Schema.Struct({}).pipe(Schema.withDecodingDefault(() => ({ ...defaultVectorBuckets }))),
    )
      .annotate({
        default: defaultVectorBuckets,
        description: "Vector bucket configuration.",
        tags,
      })
      .pipe(Schema.withDecodingDefault(() => ({ ...defaultVectorBuckets }))),
  }).pipe(Schema.withDecodingDefaultKey(() => ({ ...defaultVector }))),
}).pipe(Schema.withDecodingDefaultKey(() => ({ ...defaultStorage })));
