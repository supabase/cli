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
      upstreamVersion: "17.11.0.011",
      revision: 0,
      image:
        "ghcr.io/supabase/cli/postgres:17.11.0.011-r0@sha256:9a0eae54eb663be4b8a021382e9d290eb1960398d3b9825856b81d6944c48834",
      upstreamImage: "supabase/postgres:17.11.0.011",
      natives: {
        "darwin-arm64": {
          archive: "de01b042eb3da72a3bce4b00b8f07e4b22545d9a2aad83d5b312918eadb39f44",
          manifest: "8298f20dac793bb997a3d0110bca2f7296ed038d18ded274a43317360955cbaf",
        },
        "linux-amd64": {
          archive: "986389e7cdfc81e30c5b2f8e3e15bca98377374c1124b80d1740d0035e657128",
          manifest: "10ba0c16e8c5160be1dc7cf4e3698e661c8bd3bf7353b6f78e7022d9cf6a5591",
        },
        "linux-arm64": {
          archive: "0baab2d07d1437c640aeed7cf60a851c1f81cb85426c8fe5ebfb7ac6ee06dbd0",
          manifest: "ae8de4c02229ac55f5db9edd54cb01a674a3d06a858187245af97353707f4556",
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
      "15.19.0.013": {
        upstreamVersion: "15.19.0.013",
        revision: 0,
        image:
          "ghcr.io/supabase/cli/postgres:15.19.0.013-r0@sha256:67653acb0da765ba32c7287664dccd7032b9f62b4598e7b9e303e52c379ff281",
        upstreamImage: "supabase/postgres:15.19.0.013",
        natives: {
          "darwin-arm64": {
            archive: "f81bf652bf772551a6aa9648a445a06203880fbbcd241da1f73a484cf266b53c",
            manifest: "74cbb42cde57c09dd2feb459f56d9006bd29c9f4445f9fe13fa0b993cd40195d",
          },
          "linux-amd64": {
            archive: "1509997d8f6c32a0de8c48dc110fbf634dbd4492f382e959a6a121c6f2df3aa7",
            manifest: "0a1117031a4170903998ca7fb7f317a9efbaa4f867d808b18bdee986cef5629c",
          },
          "linux-arm64": {
            archive: "8d14a66afe2f77cfb7535614a68c39df20837ab41739fa358be908e7a2fbbd25",
            manifest: "49f9bb195851200b71d741dfe066b4569975a1efbe3e9b476fb042032945f94d",
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
      "17.11.0.007-orioledb": {
        upstreamVersion: "17.11.0.007-orioledb",
        revision: 0,
        image:
          "ghcr.io/supabase/cli/postgres:17.11.0.007-orioledb-r0@sha256:a62869318bce0ad728467c2ff3e15738cfb5d99cb766e052e8534960975afa01",
        upstreamImage: "supabase/postgres:17.11.0.007-orioledb",
        natives: {
          "darwin-arm64": {
            archive: "aedf303d33aaafdd109750d4c8435bb799b106b64a9241e03abb301eba37353b",
            manifest: "2786921fac103062604afa982d182e169d635775964be94f1dced810e8d01741",
          },
          "linux-amd64": {
            archive: "534128c4c64693b5625ab2cc17f0c26be98e96d0a98eeb6e8c8d1b7e3805a940",
            manifest: "eb3bb0177288d468abf5cb6e86ea0f9af69b165e72e3f6244dbd2551d87eca13",
          },
          "linux-arm64": {
            archive: "7122ddc908d48833c1c8f4410921a634ff98d86ac61b1d88d996bb053ef168e3",
            manifest: "99ded1c4adf9a1a8ed3798463abad775e07f0231b5f421706bc2ce42290c9cc5",
          },
        },
      },
      "17.11.0.008-orioledb": {
        upstreamVersion: "17.11.0.008-orioledb",
        revision: 0,
        image:
          "ghcr.io/supabase/cli/postgres:17.11.0.008-orioledb-r0@sha256:99d6197f871836ca0db2780d6394a3e906581a9afacc135a4aed64ad2440e3d3",
        upstreamImage: "supabase/postgres:17.11.0.008-orioledb",
        natives: {
          "darwin-arm64": {
            archive: "2d226fa1638651e93f2b093d1db29385b9994370e3600441202fe0916cf0f83a",
            manifest: "27bf40f038982607558233465e8c582d58620d2d7c22cf2efa32de086a34aa84",
          },
          "linux-amd64": {
            archive: "807f8e70001ce2c7d770e2e93187cd5b88d00351d2f0e69aecc7ed994ebfb662",
            manifest: "f1fa6e01e1230b66bad4e3b4d097b0ad9802a93e97b102a6114f1c04e0f7e024",
          },
          "linux-arm64": {
            archive: "5dae0486dc909c0831b73b29edd8bfe84904781796d5cfd9ca5d4b0946e6f741",
            manifest: "21287142ea7a0df316ae83acf796e76704e53d0db254dad8a43cab0897346d02",
          },
        },
      },
      "17.11.0.011-orioledb": {
        upstreamVersion: "17.11.0.011-orioledb",
        revision: 0,
        image:
          "ghcr.io/supabase/cli/postgres:17.11.0.011-orioledb-r0@sha256:4fd10c449c500bac93c5b481e5fd1243a88cd5e73dccff114c07502ca6efc903",
        upstreamImage: "supabase/postgres:17.11.0.011-orioledb",
        natives: {
          "darwin-arm64": {
            archive: "9bfcbf53f022134a7cf59118614d76f58f99601024c7da1dcc02c469e20e0dce",
            manifest: "051a0903da4a114c506ccb5aa3882226fccc696399b9bdc0fa319b7673d430c0",
          },
          "linux-amd64": {
            archive: "dc1b6ed700c84b487348885a0a30ebaf9d1a51d273ca3fa61f52ab7c5020a7d8",
            manifest: "fe7de179c5c0557239fcef08afbcc2d881ba440e0241db211d7de39af010f908",
          },
          "linux-arm64": {
            archive: "42140929c1fb386fbbb80af2d1fba005990c85f5e25434949ae0d5011ea7ecf6",
            manifest: "d6bc300af6ded866b47c945cb65d861f99c607b9d7c703710e75e32b9fd9c9ab",
          },
        },
      },
      "17.11.0.013-orioledb": {
        upstreamVersion: "17.11.0.013-orioledb",
        revision: 0,
        image:
          "ghcr.io/supabase/cli/postgres:17.11.0.013-orioledb-r0@sha256:8d69e5ca7393e3cee525f414bf5daed91bcd3461084668b98f8a89561395ba4a",
        upstreamImage: "supabase/postgres:17.11.0.013-orioledb",
        natives: {
          "darwin-arm64": {
            archive: "a881ef4a9efd0cf6c72cc8dc7907eb5b3d076abd65dafede14dcf6557c2581b9",
            manifest: "1bd52c8e25dcb8c87176f1536d0c28f4cf1a43a48c8e4b91ce35a337d1840912",
          },
          "linux-amd64": {
            archive: "0f3c2e89d0e91a5b8f88e68e5781c1ba8ed98f05a6119b25b5611e0da46ef9ea",
            manifest: "39abc97b5fb7417264014f098b8588332b984d383f7530416d4f7189f48c46e3",
          },
          "linux-arm64": {
            archive: "8cf2a264a0b91186df4d12a49879426ecf4771495751cb02ef29af7b52244939",
            manifest: "8dbc5ebdb5861a8b195e273b1a27c235d8ce856c521fe5c6f6201f0a1b43b692",
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
      upstreamVersion: "v2.150.1",
      revision: 0,
      image:
        "ghcr.io/supabase/cli/realtime:v2.150.1-r0@sha256:6f75bf5535355f75701f9deb4624539f4bb9a201fd8f564c8b926da840e51b12",
      upstreamImage: "supabase/realtime:v2.150.1",
      natives: {
        "darwin-arm64": {
          archive: "3635042133be81568ea93ce2e03959326ebf4f546e4ffb4beacd8a533b730b6d",
          manifest: "f9e16001977765c316c286ea5a777ef312e0a490aab7a1d98a4b03354d0f1ad2",
        },
        "linux-amd64": {
          archive: "ad085965c3a0879361dccac4b53c8abd22caa614caaddc23e1d7d093747ac70c",
          manifest: "0a4a5e43e9c1e4d1fe46c2b964f4b6c1b33b1b0f3ee75f8905a1ed14716633ef",
        },
        "linux-arm64": {
          archive: "97d2ef24887351be36ed42a2bccd18b0eae6f9c9f108a3e22b7e9a9a1e12bc21",
          manifest: "f6fe854f8c9e050c949d7480b6045749931c8f80bfa380684ff776ad0da64058",
        },
      },
    },
    "bin/server",
    ["bin/server", "bin/prepare"],
  ),
  storage: definition(
    "storage",
    {
      upstreamVersion: "v1.84.36",
      revision: 0,
      image:
        "ghcr.io/supabase/cli/storage:v1.84.36-r0@sha256:9eb28fa8a52f99fbf6aaeec8d079daa31d9d067e68a7c539cfb8871860f9dddc",
      upstreamImage: "supabase/storage-api:v1.84.36",
      natives: {
        "darwin-arm64": {
          archive: "8ee898d729877351d92e687fc8f3864b0ab5ef4370f0b54b9de047c2b525175d",
          manifest: "5fd3d7e4cf1158360f22d5fde8870d85edadf395e11ff8df290cd67382a81fba",
        },
        "linux-amd64": {
          archive: "84445a8ef385b453fa1c7d0909b38fa9f93c3e2fb9096b3acaae04fd6e9a7657",
          manifest: "4d90b1cc5355975d036cd47ca42bb3ac6cd7d467cf5706f56603bf9c97a3f9fd",
        },
        "linux-arm64": {
          archive: "5239ee032f36191f6b5162b0924dd62e31aa972bdd0a9d6cdbcbced648d8ec74",
          manifest: "dac73ba2310a97726e4ad9894f1ebb51fd2e5dbd05a061106c8209f2e1ecc963",
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
      upstreamVersion: "v1.77.9",
      revision: 0,
      image:
        "ghcr.io/supabase/cli/edge-runtime:v1.77.9-r0@sha256:1d2d920e96fe72bdff308f855a30a60a51baf4d9c3b396c16b36eb193daf6f61",
      upstreamImage: "supabase/edge-runtime:v1.77.9",
      natives: {
        "darwin-arm64": {
          archive: "d2d14cadc53254416c1ecc89dd0575efd4733cb72025ff97495d3a87980acf39",
          manifest: "1d4ae4b525a5b6f5729e811664dbfdf60bb9bc453a5e71abf6947253c20563b0",
        },
        "linux-amd64": {
          archive: "d61748740756c192d83b2d5e6960bc20e2eb748fd7aee7620bfd4bf5854013b6",
          manifest: "a25c0f4e9bfaa1583314906e1cb0ce06b5ac0a78f349e2db5f08a1ed669ce85e",
        },
        "linux-arm64": {
          archive: "5e247316b1965f84d8748de0da92e4c8d2af20d6d5e6dccdf5da35e7e0dfbff4",
          manifest: "8e259a40d00950f311082b89517ebc04323d3c8106432c88f64e59f61c5c860e",
        },
      },
    },
    "bin/edge-runtime",
  ),
  studio: definition(
    "studio",
    {
      upstreamVersion: "2026.10.26-sha-478bd88",
      revision: 0,
      image:
        "ghcr.io/supabase/cli/studio:2026.10.26-sha-478bd88-r0@sha256:5a86b793ea2a9c46bc68911881e484eab05dc1143abc9efe46604f8a90df2d3f",
      upstreamImage: "supabase/studio:2026.10.26-sha-478bd88",
      natives: {
        "darwin-arm64": {
          archive: "0f9f1a9dd0a6e9d24d88ddf85aa0b813878aa4b7ac09cd126e45a6b43bf322f9",
          manifest: "5e0f8aa4180b85f58a8affd5c86d6cade3d6cce14267c6d4869ec8531158c010",
        },
        "linux-amd64": {
          archive: "82ab932598eafab0709570885ac6d071881be943d3b42a8a94d249024aac83dd",
          manifest: "66520a9d0aabb08637c7a36972f42f0e01a3f19d9ac456d5d70e01338ce7a121",
        },
        "linux-arm64": {
          archive: "b5812235d38c09a08a130181bf0338b930e4a56573fa414ba82c4dde9ed3e2d2",
          manifest: "0cc6d656347087295acc23a5013c48ef6129f06225a222c2ef9986be92fa18cc",
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

/** ECR Public mirror of every slim image, under the same tags and digests. */
export const SLIM_IMAGE_SUPABASE_ECR_MIRROR = "public.ecr.aws/supabase/cli/";

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
