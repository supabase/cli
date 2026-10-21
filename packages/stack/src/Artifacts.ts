import { Data, Effect, Path, Record, Schema } from "effect";
import type { StackFailureKind } from "./FailureKind.ts";
import { makeArtifactStore } from "./preparation/ArtifactStore.ts";
import { SLIM_IMAGE_GHCR_REGISTRY, slimReleasesUrl } from "./preparation/SlimEndpoints.ts";
import {
  makeSlimServicesSource,
  type SlimServicesArtifact,
} from "./preparation/SlimServicesSource.ts";

type NativeTarget = SlimServicesArtifact["target"];

export type ServiceKind =
  | "database"
  | "rest"
  | "auth"
  | "realtime"
  | "storage"
  | "imgproxy"
  | "functions"
  | "studio"
  | "pgmeta"
  | "mail"
  | "analytics"
  | "pooler";

/** A catalog artifact: a stack service kind, or an artifact only the legacy `supabase start` runs. */
export type ArtifactKind = ServiceKind | "vector";

const isServiceKind = (kind: ArtifactKind): kind is ServiceKind => kind !== "vector";

export class ArtifactError extends Data.TaggedError("ArtifactError")<{
  readonly message: string;
  readonly service?: string;
  readonly version?: string;
  readonly platform?: string;
  readonly cause?: unknown;
  readonly kind?: StackFailureKind;
}> {}

/** Lowercase hexadecimal SHA-256 digest. */
const Sha256 = Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/u));

/** Content digests of one native target's published archive and manifest. */
export const NativePin = Schema.Struct({ archive: Sha256, manifest: Sha256 }).annotate({
  identifier: "NativePin",
});
export interface NativePin extends Schema.Schema.Type<typeof NativePin> {}

/**
 * One published slim-services revision of an upstream version, pinned by content. A pin stands
 * alone and need not be in the compiled catalog; a service kind's executable and runtime paths
 * come from its artifact definition.
 */
export const ArtifactPin = Schema.Struct({
  upstreamVersion: Schema.String,
  revision: Schema.Int,
  /** `ghcr.io/supabase/cli/<service>:<release version>@sha256:<digest>`. */
  image: Schema.String,
  /**
   * The exact upstream image this release was built or mirrored from, as slim-services recorded
   * it: the release manifest's `upstream_image` for a derived service, or the release's
   * `oci-provenance.json` `source` for a mirrored one (vector, mailpit, imgproxy). Normalized to
   * the Dockerfile's `FROM` form — no leading `docker.io/`, no digest — so legacy non-slim mode
   * can use it as the upstream tag directly.
   */
  upstreamImage: Schema.String,
  natives: Schema.Struct({
    "darwin-arm64": NativePin,
    "linux-amd64": NativePin,
    "linux-arm64": NativePin,
  }),
}).annotate({ identifier: "ArtifactPin" });
export interface ArtifactPin extends Schema.Schema.Type<typeof ArtifactPin> {}

/** The pin each stack service runs, chosen once per command and written into every creation. */
export type ArtifactSelection = Readonly<Record<ServiceKind, ArtifactPin>>;

/** The published release version, `<upstream>-r<revision>`. */
const releaseVersion = (pin: ArtifactPin): string => `${pin.upstreamVersion}-r${pin.revision}`;

interface ArtifactResolution {
  readonly service: ArtifactKind;
  /** Upstream version. */
  readonly version: string;
  readonly releaseVersion: string;
  readonly image: string;
  readonly natives: ArtifactPin["natives"];
  readonly executablePath: string;
  readonly requiredRuntimePaths: ReadonlyArray<string>;
}

export interface PreparedNativeArtifact {
  readonly service: ArtifactKind;
  readonly version: string;
  readonly root: string;
  readonly executable: string;
  /** The generation's digest lock file; a native workload spawned from `root` pins this too. */
  readonly lockPath: string;
  /** Whether this call downloaded the generation or found it already installed. */
  readonly outcome: "cached" | "downloaded";
}

interface ArtifactDefinition {
  readonly sourceService: string;
  readonly defaultPin: ArtifactPin;
  /** Compiled pins keyed by upstream version. */
  readonly pins: Readonly<Record<string, ArtifactPin>>;
  readonly requiredRuntimePaths: ReadonlyArray<string>;
  readonly executablePath: string;
}

const definition = (
  sourceService: string,
  pin: ArtifactPin,
  executablePath: string,
  requiredRuntimePaths: ReadonlyArray<string> = [executablePath],
  additionalPins: Readonly<Record<string, ArtifactPin>> = {},
): ArtifactDefinition => ({
  sourceService,
  defaultPin: pin,
  pins: { [pin.upstreamVersion]: pin, ...additionalPins },
  requiredRuntimePaths,
  executablePath,
});

const definitions: Readonly<Record<ArtifactKind, ArtifactDefinition>> = {
  database: definition(
    "postgres",
    {
      upstreamVersion: "17.11.0.006",
      revision: 0,
      image:
        "ghcr.io/supabase/cli/postgres:17.11.0.006-r0@sha256:ee0f2d9747fb9d3c0a29703684ec718f070384ad05bf0d92823ed02cabde8e5a",
      upstreamImage: "supabase/postgres:17.11.0.006",
      natives: {
        "darwin-arm64": {
          archive: "fb7594525d712ab85b6da00d4d4854f8d0c9ba26b49b781a5fede0119362e917",
          manifest: "b499127a253b15f362fa217301d490f5d61f4b201d1b6501de06a11c6347e192",
        },
        "linux-amd64": {
          archive: "f3a4389c92c550597cacf8c71c74af025b8e75259753c4e78bb5014e6f29e6f2",
          manifest: "457949debc6c8b1d17dfaedcdef4883af3ff1ef7a15998f74d9511294be9a2fa",
        },
        "linux-arm64": {
          archive: "443bb6be464b78fcc9a1e07d94cc4e8a5f0f9cba3d4ca3d5d8a8563fa962fddb",
          manifest: "fd0f71d0f42898657a69962475164f4446f8f732edfac248708593b36eec4fcf",
        },
      },
    },
    "bin/supabase-postgres-start",
    [
      "bin/supabase-postgres-start",
      "bin/postgres",
      "bin/pg_dump",
      "bin/pg_dumpall",
      "bin/pg_prove",
      "bin/psql",
    ],
    {
      "15.19.0.006": {
        upstreamVersion: "15.19.0.006",
        revision: 0,
        image:
          "ghcr.io/supabase/cli/postgres:15.19.0.006-r0@sha256:dd5d757785930d2daf216ccc2ea871e2337657d11c42f7cc709309774fa663f1",
        upstreamImage: "supabase/postgres:15.19.0.006",
        natives: {
          "darwin-arm64": {
            archive: "0350c9ff12f84061f1a35de8218400fb8e6059dedd36d037bd01e9b7adde3e4b",
            manifest: "a2d941b715b0fa09918353164f13fac47751973ab5ae4ceca978bb8263c41f62",
          },
          "linux-amd64": {
            archive: "3e0126f154c174a88c45a9fa496441e1a15e2f328e4ad3b61fcc02c9caead69c",
            manifest: "af86fad4f63a9bafbc853e8291275d95762da609e9775129f7debbdcdd35c1bb",
          },
          "linux-arm64": {
            archive: "ec1f08c01a110aa267c646a7ab69dc63e2e544c5d9d0c0536cfb974423280b3a",
            manifest: "7527e460894f9ef76c57ec03359db5e8cc4d8fdb7043f727f4213344d9f3e76c",
          },
        },
      },
      "17.11.0.002-orioledb": {
        upstreamVersion: "17.11.0.002-orioledb",
        revision: 0,
        image:
          "ghcr.io/supabase/cli/postgres:17.11.0.002-orioledb-r0@sha256:8bfda219b7748273a46c3f097df3562a73087df8170ca4be4316f8215bf6b765",
        upstreamImage: "supabase/postgres:17.11.0.002-orioledb",
        natives: {
          "darwin-arm64": {
            archive: "66670aca62cb96a5eb555bc6d0b39e1e2581247b664c75bb3325a44eac475843",
            manifest: "2a0ac16cc7cfa78a44a3876cdacd8f77622a85c55458bd80fa465daaab76b478",
          },
          "linux-amd64": {
            archive: "a2ea7fdd73f5f516db52ae05ca6ea52d8c94423177503f42ee8c9c2dd2474104",
            manifest: "71d538e058c642b6cf7277f935074c3022b45a464079f9797ab0656d2edf2bdb",
          },
          "linux-arm64": {
            archive: "981c0c74ca229bb1744675527599d1180a9adef85314d2d4c0e46406c5cfa0bd",
            manifest: "3faab299bedc021f5e7208d761614f3ee8a3fe08439de901a94ba2889ede404f",
          },
        },
      },
      "17.11.0.005-orioledb": {
        upstreamVersion: "17.11.0.005-orioledb",
        revision: 0,
        image:
          "ghcr.io/supabase/cli/postgres:17.11.0.005-orioledb-r0@sha256:aa141c2d1f9b0eb2e96681781f6ff2226f6f29466308e660be565b7eb781462f",
        upstreamImage: "supabase/postgres:17.11.0.005-orioledb",
        natives: {
          "darwin-arm64": {
            archive: "5526b890ac015f4714f6dee460acc9aa0687e35f156cf437544f16fdfe812ba7",
            manifest: "dde250a7063b05ea39329b00911397976357a037c3446fa1f6b6a66e5a49cb65",
          },
          "linux-amd64": {
            archive: "a5ebf59e43cd247819f2ce6a43cd3481baf2caf2492d39f04f1484c1bc71f499",
            manifest: "6611a0d4e0e78faa477e00b43f48737be126ed8f2484f2ebf95658b8b2bdaefa",
          },
          "linux-arm64": {
            archive: "772b2324480bff79fdc4fd0c018b7c23295b63566997db3e65cafc51178a9f08",
            manifest: "1d1ad6a4c30b8417880ba818cdd4dc29e69acd87a5c874e1e766be025636b954",
          },
        },
      },
      "17.11.0.006-orioledb": {
        upstreamVersion: "17.11.0.006-orioledb",
        revision: 0,
        image:
          "ghcr.io/supabase/cli/postgres:17.11.0.006-orioledb-r0@sha256:d1b3cb9421c5448dd1d226856344ef7abdd828a6d27722a1de11b3c0f5c46fc7",
        upstreamImage: "supabase/postgres:17.11.0.006-orioledb",
        natives: {
          "darwin-arm64": {
            archive: "6e6a90857cf3f6637b22e182856b18425fe6c12af80ef065b6dce736ce5a914c",
            manifest: "5433b222cc40036069ab60fdfdf1e468c2ca1268a01f505b6a835c62f770abb8",
          },
          "linux-amd64": {
            archive: "b7ea7bcd9953e4dec1af75d26e2a96cd753d8ebafb12f01c91d0baf0d2fbe6e2",
            manifest: "280b0d449ae5ca09631cf362bd8c228abff638bafc832f39849a13828e66fc88",
          },
          "linux-arm64": {
            archive: "b5bd6e730b89c3c150107740e1489b0bc1ce2ea3e8f802470e4c2bd7f88570e2",
            manifest: "0cde8aff915fb425db9dadffbd3c0307b420f4e1c2b1b3a1c0dc1849ef296c47",
          },
        },
      },
    },
  ),
  rest: definition(
    "postgrest",
    {
      upstreamVersion: "v16.5",
      revision: 0,
      image:
        "ghcr.io/supabase/cli/postgrest:v16.5-r0@sha256:11421115f972012e05e515bbb28df07f38cb7a966b8da251d2d1d3e5b34527cd",
      upstreamImage: "postgrest/postgrest:v16.5",
      natives: {
        "darwin-arm64": {
          archive: "554fd826083c9d1e384aa39dc3bc5d56f17c4a90e1088b6e821a9c7b9f15567b",
          manifest: "20469b7dd05d6edb1abe2e8074531e3558604bca335056e2946c0ee7d2ec69c9",
        },
        "linux-amd64": {
          archive: "e224ec6209a4ff800524c54e3b11715ede07aa3923154e44e97a67bb786b6417",
          manifest: "644809d3e7912ef4c1273e848e0a0b52b8c353b909c1b63e95eb7c3d6413f12b",
        },
        "linux-arm64": {
          archive: "89cddaa3a08cd252ea24a28ae3acf13d74e572cb57b721cfe70743de266e9028",
          manifest: "8097ef1fa2036d6dd735488a4aac82b0f128483171672d0a4662c48a045149a8",
        },
      },
    },
    "bin/postgrest",
  ),
  auth: definition(
    "auth",
    {
      upstreamVersion: "v2.197.0",
      revision: 0,
      image:
        "ghcr.io/supabase/cli/auth:v2.197.0-r0@sha256:7eb303831d170865840dbb3f9018b48561c988704ad1d9a2bafabb4e93e92da5",
      upstreamImage: "supabase/gotrue:v2.197.0",
      natives: {
        "darwin-arm64": {
          archive: "eb365c4aea1e1cd04998ed16cd49b1b90e6a097ce633e5ee55f8bbbebdd349c7",
          manifest: "178f748da1c886b07945a67a839d3a17fa546e01215a90329ded1a634831deb6",
        },
        "linux-amd64": {
          archive: "bd8f59ed1a817014afe71288c2275ad0396630f016f8cb5ab5129388860ec49b",
          manifest: "ccad45ee54edf7506b055b85dcebee6db8c5b9ec57ac3c6d30baf38bb81b1deb",
        },
        "linux-arm64": {
          archive: "9598a8dd5a08707f65795505211c479b686c54e3dadbe64b3e1989855215cf0c",
          manifest: "4f5f3a6284f0b161cf49a201fe551470d5b6e0e2b37dedb4dacdd0e42abaf3b1",
        },
      },
    },
    "bin/auth",
  ),
  realtime: definition(
    "realtime",
    {
      upstreamVersion: "v2.145.5",
      revision: 0,
      image:
        "ghcr.io/supabase/cli/realtime:v2.145.5-r0@sha256:d1b3dda7f8a9a4045b830d083ec8ac8242569a43c78577af9da36bffa5e65968",
      upstreamImage: "supabase/realtime:v2.145.5",
      natives: {
        "darwin-arm64": {
          archive: "c6fd679b107bb436a0f2794ddfe94ea46aaa52de0bd5523d7f4c553e688aca48",
          manifest: "36f6727174ec8e522508d6b011b265c9fbbfb710fa6e48270bf221adc34561cd",
        },
        "linux-amd64": {
          archive: "c5dcbd8837daa539838bab8adcf4a8e3b08ad60b6d2a677ac2020de7de81d710",
          manifest: "899a989b00499186527994e468511d359230ce8860635f7fe055294e78503883",
        },
        "linux-arm64": {
          archive: "35be9b17d46bbfe50502f41ba1f68d561d073f634912347ff7e3b5f2f6d73a70",
          manifest: "7b18c917fa46fbdb93468078040ca173b7a66420b86121a0f7f20cd278a3394b",
        },
      },
    },
    "bin/server",
    ["bin/server", "bin/prepare"],
  ),
  storage: definition(
    "storage",
    {
      upstreamVersion: "v1.84.0",
      revision: 0,
      image:
        "ghcr.io/supabase/cli/storage:v1.84.0-r0@sha256:837c299c73d5fa0ada05cb4d9648186e1bb1d500d5892db7d12601bde5674f7b",
      upstreamImage: "supabase/storage-api:v1.84.0",
      natives: {
        "darwin-arm64": {
          archive: "f3024fa9b6fc34407acbad41b3b99be5e527869a29e575870bc0a3e92a2bc49f",
          manifest: "e088b3add2c659771ceeb73288720e632adbd34571b0424e93f217ed4a70f4ab",
        },
        "linux-amd64": {
          archive: "685dcdb7ada3c4551de9c517844b51ae6c94dbc6112b14d9cb1ca57c0f110327",
          manifest: "5db6aa659348a72757ba808c3f0829f7c3b0aa31405c327f2bfb45e7bd5dd1a4",
        },
        "linux-arm64": {
          archive: "82e8c364480c28310990a3573ea8b487e46282d7895decbf6a4ef6ef345aecda",
          manifest: "a1ae9e8846df92c49c7cb4570c9d0b0e1641c685fcfeffbac77c185de982d7fb",
        },
      },
    },
    "bin/storage",
    ["bin/storage", "bin/prepare"],
  ),
  imgproxy: definition(
    "imgproxy",
    {
      upstreamVersion: "v3.26.0",
      revision: 0,
      image:
        "ghcr.io/supabase/cli/imgproxy:v3.26.0-r0@sha256:5871582cf6c5140d3b50b21e0d1aa236fdf46ee6133e3bfec1baf63545e01cf0",
      upstreamImage: "ghcr.io/imgproxy/imgproxy:v3.26.0",
      natives: {
        "darwin-arm64": {
          archive: "1f82084b056bf4806bf492bca0b6f963068d07a6776a2a122b61da940732683b",
          manifest: "53b5c4f4f069db88c3919571dbee12af2373e5c90db291cf5d7456aa74e17ecb",
        },
        "linux-amd64": {
          archive: "7865edf054b8217c2daf9d42bce6bebe34f83df5c4183fbbe6495a3603dcd4a8",
          manifest: "5ae7f22a6fbdc55f41ffc3334747a3475295676699ac1d2c372bc5fe2ad239bb",
        },
        "linux-arm64": {
          archive: "4528fd7877c9df3052cd6ec06c8cafd7e92977dd26490fb532964c19faec3b0a",
          manifest: "5420e6d9b3661060b2dedfe157c18b56f22011c43cc3127031b4bbc65e936b59",
        },
      },
    },
    "bin/imgproxy",
  ),
  functions: definition(
    "edge-runtime",
    {
      upstreamVersion: "v1.77.8",
      revision: 0,
      image:
        "ghcr.io/supabase/cli/edge-runtime:v1.77.8-r0@sha256:a162f950a1f5f69e40afcb2a72a2dd924fe14884cf6b9591723ef69ddcaaedb2",
      upstreamImage: "supabase/edge-runtime:v1.77.8",
      natives: {
        "darwin-arm64": {
          archive: "6e114f7817beebac350be6bfbd14d12bd3e2b0b2d6e7a2e94eb11ede68213a60",
          manifest: "7ee23c9287653a8239963c347a1887f5c541f69bfb356b3f7576cafbf467d528",
        },
        "linux-amd64": {
          archive: "af349b253f0ad192d2eaba0b584a0e8a96118ce1b39f514389f40c66ea4e7502",
          manifest: "c560ecd5c85bda5ba13f4deb1fc7138291af3149da018d8e83593b64e225a5ab",
        },
        "linux-arm64": {
          archive: "1360ec1f775b62cc81f2469ddfc53840034e9b9e73e02c2594be332ad3218dbe",
          manifest: "3208b8a22583cae5522b64cac87b49c8210a32bf29dde6b24a9f7900bffa787d",
        },
      },
    },
    "bin/edge-runtime",
  ),
  studio: definition(
    "studio",
    {
      upstreamVersion: "2026.10.19-sha-b375769",
      revision: 0,
      image:
        "ghcr.io/supabase/cli/studio:2026.10.19-sha-b375769-r0@sha256:aef5aadd8f3a449998850ee1bc40b2c0d765555756df5779dd6d7208d6d77a93",
      upstreamImage: "supabase/studio:2026.10.19-sha-b375769",
      natives: {
        "darwin-arm64": {
          archive: "6ee00298ee5566b442b359d4accb0f12a6deb1f26b01188a49225b978a95b04c",
          manifest: "be6008eef35a121a61ca94da3135436f3e638bb70fcc47f378ba66fd06333c4f",
        },
        "linux-amd64": {
          archive: "4a83bf5134cb4306b12d47b993def4e54e0675accec097ab3fc2dea3626aa6d0",
          manifest: "938a6290af7f138ebf025bfd5cf9482c236745ac5819748ddbfdeaf3cd4c328b",
        },
        "linux-arm64": {
          archive: "9804db2a36abb418194026dee2aaa9e3ae5d52386346576f72fc64c0420795ac",
          manifest: "df0719d05a2be15f015db9259c35445ea69be5ad86546f3cad79a5652d28fcd7",
        },
      },
    },
    "bin/studio",
  ),
  pgmeta: definition(
    "pgmeta",
    {
      upstreamVersion: "v0.100.0",
      revision: 0,
      image:
        "ghcr.io/supabase/cli/pgmeta:v0.100.0-r0@sha256:1dc3ce4f710e9696ec1374f89d0dc84291104c9a1ce030f9ac999670d4d74a08",
      upstreamImage: "supabase/postgres-meta:v0.100.0",
      natives: {
        "darwin-arm64": {
          archive: "adecdf5168a9e43056d4e3d78122960b3f645607f6b64e7e178522ad8ca7f3e4",
          manifest: "edf539c9a613c4f0d2d4ccf5d245c8fd57b60d158bcc7c24a18f343236529c69",
        },
        "linux-amd64": {
          archive: "5df0dfb03469f358858b8768f39db9a77b5947ec0567aff1056fddbfa1f2db75",
          manifest: "3095c4655e8f35451fdb84194065a31c4edee9b52fd5b28ac01dfdae620e07a1",
        },
        "linux-arm64": {
          archive: "8289012110b6b466d8366ceb2e6f731eca9b46020046b585438f988615666a22",
          manifest: "349d37edae9ac07d15543e7acf5bae288112850285dee28c602cd6c04ea11c1a",
        },
      },
    },
    "bin/pgmeta",
  ),
  mail: definition(
    "mailpit",
    {
      upstreamVersion: "v1.31.3",
      revision: 0,
      image:
        "ghcr.io/supabase/cli/mailpit:v1.31.3-r0@sha256:ed9b00c609e77e99c79b93f1178255ebc271868920f2c69a8d166bd5634ed10d",
      upstreamImage: "axllent/mailpit:v1.31.3",
      natives: {
        "darwin-arm64": {
          archive: "d460a6a55693a2a321ad83ebb83417b8078324751a744f982bb3512da0632712",
          manifest: "43177dc88b6f625bec6d98096e39c10f4cd10956081df01b5b7cebeeae47766a",
        },
        "linux-amd64": {
          archive: "57e39cb39b2288313e26abe9ae9300f6af9332abd1f76f4d67be533741b2c942",
          manifest: "36595519f40e406b17a0ce6e21f153400f217ae24b0365f0a5c495ff315b9f82",
        },
        "linux-arm64": {
          archive: "805b09d9008e9be2c6c9230e668bd2c6ab446eeae26389e91732f9e20b2c3f5f",
          manifest: "973b76700a5a865243bd5a5c36664121ed99c538d58633921cc8fd7c675e655c",
        },
      },
    },
    "bin/mailpit",
  ),
  analytics: definition(
    "analytics",
    {
      upstreamVersion: "v1.50.15",
      revision: 1,
      image:
        "ghcr.io/supabase/cli/analytics:v1.50.15-r1@sha256:2b03ec3120effe5d33c1e2ec4570a932fb60ce6a6851b4920a22388b4e8356c1",
      upstreamImage: "supabase/logflare:1.50.15",
      natives: {
        "darwin-arm64": {
          archive: "abfc9ba64e354129e8f8b0f38b43747a5dab48785fd3593d11e52cd6e0ff37bf",
          manifest: "60647643f5521089978dc20c6966b86ed939b9751b187cbb70e0de3fbd2479ac",
        },
        "linux-amd64": {
          archive: "7652456c1a1d73ac6fe10853bd8a38e79139b43fe796caec5725a3d0f225a3d8",
          manifest: "6c465af69e26ce8a9c15988d5dcbbae069e9a92b697962bfa86c4f3e601b8409",
        },
        "linux-arm64": {
          archive: "a75625d7c903d70e749b5ee776e2c5c98d51ee60ff92b28bb6684121fe0f3888",
          manifest: "ca2569304cf24e6abd4242b55dd0d20338f40532fbe6377a9accdc5d47ea47ab",
        },
      },
    },
    "bin/logflare",
    ["bin/logflare", "bin/prepare"],
  ),
  vector: definition(
    "vector",
    {
      upstreamVersion: "0.58.0",
      revision: 0,
      image:
        "ghcr.io/supabase/cli/vector:0.58.0-r0@sha256:5dcf67db0ee378caa87f3395cb9484ebe3e97bb0334d119f2ac33116e00c5773",
      upstreamImage: "timberio/vector:0.58.0-alpine",
      natives: {
        "darwin-arm64": {
          archive: "567245cf9a7d54eee45ecf74e1c9a61ca6d02cdca103edc7b32b005e54f4e632",
          manifest: "a973a763b00599858ceae8f304714fb99f785860112e9e0812ef0df8f81dd2ee",
        },
        "linux-amd64": {
          archive: "697f4fae35be3026474695bef16336f6fcfd429ce8cfba884c595896e96c30ec",
          manifest: "8989b8b061f08bd7653e9ae71c6ee0e5cf01a0b10f2d358fe3dbc671ec5b63e1",
        },
        "linux-arm64": {
          archive: "c66b8ad0a0dd0fdcb3e4ee36bae8040b7b23b44ec2b4023565ca335884268c1d",
          manifest: "992467ec68a99a6413468b9311294abb7a1f86b7857ad37f1f3bd9e6aecc9dbb",
        },
      },
    },
    "bin/vector",
    ["bin/vector", "share/doc/vector/config/vector.yaml"],
  ),
  pooler: definition(
    "pooler",
    {
      upstreamVersion: "v2.9.13",
      revision: 1,
      image:
        "ghcr.io/supabase/cli/pooler:v2.9.13-r1@sha256:f02ccc6e18ea77789978e248ac302a4e0955d03fdeeea0d63ac0b7a315595c60",
      upstreamImage: "supabase/supavisor:2.9.13",
      natives: {
        "darwin-arm64": {
          archive: "aa53594e91144a6d33267b802152f0f42d35ca85e6efd13b9cd06f53e327fb5f",
          manifest: "1c42764f1f706cb177ee4f066c6ebcb75e15a2399e8f552488a426718d9e2edd",
        },
        "linux-amd64": {
          archive: "ff1543cebb9331646294475c609c3e231618e46f1dca53108d35f3172c1fa705",
          manifest: "1ef9f8041632ca0c96045f64092c880a3ad7a6af4febe7d0b43322b330fc19f8",
        },
        "linux-arm64": {
          archive: "ed08b8856a0516026321a47055fca5c30cea82f93dc3da8bb2ab81951342a20c",
          manifest: "12e867a370fac6aa68f1e657840d30c9d4e5cae56f38da833a26e05c688c94ad",
        },
      },
    },
    "bin/server",
    ["bin/server", "bin/prepare", "bin/provision-tenant"],
  ),
};

const targetForPlatform = (platform: {
  readonly os: string;
  readonly arch: string;
}): NativeTarget | undefined => {
  if (platform.os === "darwin" && platform.arch === "arm64") return "darwin-arm64";
  if (platform.os === "linux" && platform.arch === "x64") return "linux-amd64";
  if (platform.os === "linux" && platform.arch === "arm64") return "linux-arm64";
  return undefined;
};

/** Selects native execution where the catalog publishes native artifacts, and Docker elsewhere. */
export const defaultRuntime = (
  platform: { readonly os: string; readonly arch: string } = {
    os: process.platform,
    arch: process.arch,
  },
): "native" | "docker" => (targetForPlatform(platform) === undefined ? "docker" : "native");

const platformText = (platform: { readonly os: string; readonly arch: string }): string =>
  `${platform.os}/${platform.arch}`;

const errorMessage = (cause: unknown): string =>
  cause instanceof Error ? cause.message : typeof cause === "string" ? cause : String(cause);

/**
 * Public S3 copy of the release assets for hosts that block GitHub release downloads, such as
 * agent sandboxes that allow `*.amazonaws.com`.
 * @see ../../../infra/cli-artifacts/README.md
 */
const SLIM_NATIVE_SUPABASE_S3_MIRROR = "https://supabase-cli-artifacts.s3.us-east-1.amazonaws.com";

const SLIM_IMAGE_SUPABASE_ECR_MIRROR = "public.ecr.aws/supabase/cli/";

/** Mirrors carrying a catalog slim image under the same tag and digest, in fallback order. */
export const slimImageMirrors = (image: string): ReadonlyArray<string> =>
  image.startsWith(SLIM_IMAGE_GHCR_REGISTRY)
    ? [`${SLIM_IMAGE_SUPABASE_ECR_MIRROR}${image.slice(SLIM_IMAGE_GHCR_REGISTRY.length)}`]
    : [];

const artifactFor = (
  service: ArtifactKind,
  resolved: ArtifactResolution,
  target: NativeTarget,
  releasesUrl: string,
): SlimServicesArtifact => {
  const sourceService = definitions[service].sourceService;
  const releaseTag = `${sourceService}-${resolved.releaseVersion}`;
  const assetName = `${releaseTag}-${target}`;
  const githubRelease = `${releasesUrl}/${releaseTag}`;
  const supabaseS3 = `${SLIM_NATIVE_SUPABASE_S3_MIRROR}/${sourceService}/${resolved.releaseVersion}`;
  const pin = resolved.natives[target];
  return {
    provider: "supabase/slim-services",
    service: sourceService,
    version: resolved.releaseVersion,
    releaseTag,
    target,
    archive: "tar.zst",
    assetName,
    sha256: pin.archive,
    manifestSha256: pin.manifest,
    mirrors: [
      {
        downloadUrl: `${githubRelease}/${assetName}.tar.zst`,
        manifestUrl: `${githubRelease}/${assetName}.manifest.json`,
      },
      {
        downloadUrl: `${supabaseS3}/${assetName}.tar.zst`,
        manifestUrl: `${supabaseS3}/${assetName}.manifest.json`,
      },
    ],
    requiredRuntimePaths: resolved.requiredRuntimePaths,
    executablePath: resolved.executablePath,
  };
};

/** Binds an explicit pin to its service kind's executable and runtime paths. */
export const resolveArtifact = Effect.fn("Artifacts.resolveArtifact")(function* (request: {
  readonly service: ArtifactKind;
  readonly pin: ArtifactPin;
}) {
  if (!Object.hasOwn(definitions, request.service))
    return yield* new ArtifactError({
      message: `Unknown service kind: ${request.service}`,
      kind: "configuration",
    });
  const selected = definitions[request.service];
  const { pin } = request;
  return {
    service: request.service,
    version: pin.upstreamVersion,
    releaseVersion: releaseVersion(pin),
    image: pin.image,
    natives: pin.natives,
    executablePath: selected.executablePath,
    requiredRuntimePaths: selected.requiredRuntimePaths,
  };
});

/** The compiled default pin of every stack service; the database runs the stock default line. */
export const defaultArtifactSelection = (): ArtifactSelection => ({
  database: definitions.database.defaultPin,
  rest: definitions.rest.defaultPin,
  auth: definitions.auth.defaultPin,
  realtime: definitions.realtime.defaultPin,
  storage: definitions.storage.defaultPin,
  imgproxy: definitions.imgproxy.defaultPin,
  functions: definitions.functions.defaultPin,
  studio: definitions.studio.defaultPin,
  pgmeta: definitions.pgmeta.defaultPin,
  mail: definitions.mail.defaultPin,
  analytics: definitions.analytics.defaultPin,
  pooler: definitions.pooler.defaultPin,
});

const ORIOLEDB_SUFFIX = "-orioledb";

/** PostgreSQL major of a database artifact version or major alias. */
export const postgresMajor = (version: string): string => version.split(".")[0] ?? version;

/** Whether a database artifact version is an OrioleDB build. */
export const isOrioledbVersion = (version: string): boolean => version.endsWith(ORIOLEDB_SUFFIX);

/**
 * Release line of a database artifact version: the PostgreSQL major of a stock build (`17`), or the
 * exact OrioleDB build (`17.11.0.002-orioledb`), since a newer OrioleDB build may refuse older data.
 * Initialized data is reusable only within one line.
 */
export const postgresLine = (version: string): string =>
  isOrioledbVersion(version) ? version : postgresMajor(version);

/** Database artifact version of a `db.orioledb_version` value. */
export const orioledbPostgresVersion = (orioledbVersion: string): string =>
  `${orioledbVersion}${ORIOLEDB_SUFFIX}`;

/** `db.orioledb_version` value of an OrioleDB database artifact version. */
export const orioledbConfigVersion = (version: string): string =>
  version.slice(0, -ORIOLEDB_SUFFIX.length);

/** `db.orioledb_version` values the catalog pins an OrioleDB artifact for. */
export const orioledbVersions = (): ReadonlyArray<string> =>
  Object.keys(definitions.database.pins).filter(isOrioledbVersion).map(orioledbConfigVersion);

/**
 * The compiled database pin for a PostgreSQL major alias (the pinned stock build of that major) or
 * an exact pinned upstream version such as an OrioleDB build.
 */
export const databaseArtifactPin = (version: string): Effect.Effect<ArtifactPin, ArtifactError> => {
  const pins = Object.values(definitions.database.pins);
  const pin =
    pins.find((candidate) => candidate.upstreamVersion === version) ??
    pins.find(
      (candidate) =>
        !isOrioledbVersion(candidate.upstreamVersion) &&
        postgresMajor(candidate.upstreamVersion) === version,
    );
  return pin === undefined
    ? Effect.fail(
        new ArtifactError({
          message: `Unsupported database artifact version: ${version}`,
          service: "database",
          version,
          kind: "configuration",
        }),
      )
    : Effect.succeed(pin);
};

/** The slim-services producer that publishes releases of an artifact. */
export const artifactSourceService = (service: ArtifactKind): string =>
  definitions[service].sourceService;

/** Service kinds the stack runs, in artifact catalog order; legacy-only artifacts are omitted. */
export const artifactServiceKinds = (): ReadonlyArray<ServiceKind> =>
  Record.keys(definitions).filter(isServiceKind);

/**
 * Every catalog pin in catalog order, including additional upstream lines. `isDefault` marks the
 * pin the default selection runs (postgres's 17.x line today); every
 * other pin (postgres's 15.x and OrioleDB lines) carries `isDefault: false`.
 */
export const catalogPins = (): ReadonlyArray<{
  readonly service: ArtifactKind;
  readonly sourceService: string;
  readonly pin: ArtifactPin;
  readonly isDefault: boolean;
}> =>
  Record.keys(definitions).flatMap((service) => {
    const { sourceService, defaultPin, pins } = definitions[service];
    return Object.values(pins).map((pin) => ({
      service,
      sourceService,
      pin,
      isDefault: pin.upstreamVersion === defaultPin.upstreamVersion,
    }));
  });

const artifactKey = (artifact: SlimServicesArtifact): string =>
  `slim-services/${artifact.service}/${artifact.version}/${artifact.target}`;

/** Builds the native store request shared by ahead-of-time preparation and launch-time use. */
const nativeStoreRequest = Effect.fn("Artifacts.nativeStoreRequest")(function* (
  request: { readonly service: ArtifactKind; readonly pin: ArtifactPin },
  platform: { readonly os: string; readonly arch: string },
) {
  const resolved = yield* resolveArtifact(request);
  const target = targetForPlatform(platform);
  if (target === undefined)
    return yield* new ArtifactError({
      message: `Native artifacts are unsupported on ${platformText(platform)}`,
      service: request.service,
      version: resolved.version,
      platform: platformText(platform),
      kind: "platform-unsupported",
    });
  const releasesUrl = yield* slimReleasesUrl;
  const sourceArtifact = artifactFor(request.service, resolved, target, releasesUrl);
  const key = artifactKey(sourceArtifact);
  const source = makeSlimServicesSource((candidate) =>
    candidate.key === key ? sourceArtifact : undefined,
  );
  return {
    resolved,
    storeRequest: {
      key,
      requiredRuntimePaths: resolved.requiredRuntimePaths,
      executablePath: resolved.executablePath,
    },
    source,
  };
});

const toNativeArtifact = (
  resolved: ArtifactResolution,
  prepared: {
    readonly path: string;
    readonly lockPath: string;
    readonly outcome: "cached" | "downloaded";
  },
  path: Path.Path,
): PreparedNativeArtifact => ({
  service: resolved.service,
  version: resolved.version,
  root: prepared.path,
  executable: path.join(prepared.path, resolved.executablePath),
  lockPath: prepared.lockPath,
  outcome: prepared.outcome,
});

/** Ahead-of-time: downloads and publishes the generation, but pins nothing. */
export const prepareNativeArtifact = Effect.fn("Artifacts.prepareNativeArtifact")(function* (
  request: { readonly service: ArtifactKind; readonly pin: ArtifactPin },
  cacheRoot: string,
  platform: { readonly os: string; readonly arch: string } = {
    os: process.platform,
    arch: process.arch,
  },
) {
  const resolved = yield* resolveArtifact(request);
  return yield* Effect.gen(function* () {
    const built = yield* nativeStoreRequest(request, platform);
    const store = yield* makeArtifactStore({ cacheRoot, source: built.source });
    const prepared = yield* store.prepare(built.storeRequest);
    const path = yield* Path.Path;
    return toNativeArtifact(built.resolved, prepared, path);
  }).pipe(
    Effect.mapError((cause) =>
      cause instanceof ArtifactError
        ? cause
        : new ArtifactError({
            message: `Unable to prepare ${request.service} artifact: ${errorMessage(cause)}`,
            service: request.service,
            version: resolved.version,
            cause,
          }),
    ),
  );
});

/**
 * The one scoped launch-time operation: pins the generation, resolves or prepares it, and returns
 * its paths. Every consumer must use the returned paths only inside this scope.
 */
export const useNativeArtifact = Effect.fn("Artifacts.useNativeArtifact")(function* (
  request: { readonly service: ServiceKind; readonly pin: ArtifactPin },
  cacheRoot: string,
  platform: { readonly os: string; readonly arch: string } = {
    os: process.platform,
    arch: process.arch,
  },
) {
  const resolved = yield* resolveArtifact(request);
  return yield* Effect.gen(function* () {
    const built = yield* nativeStoreRequest(request, platform);
    const store = yield* makeArtifactStore({ cacheRoot, source: built.source });
    const prepared = yield* store.use(built.storeRequest);
    const path = yield* Path.Path;
    return toNativeArtifact(built.resolved, prepared, path);
  }).pipe(
    Effect.mapError((cause) =>
      cause instanceof ArtifactError
        ? cause
        : new ArtifactError({
            message: `Unable to prepare ${request.service} artifact: ${errorMessage(cause)}`,
            service: request.service,
            version: resolved.version,
            cause,
          }),
    ),
  );
});
