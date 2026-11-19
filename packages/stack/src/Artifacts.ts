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
      upstreamVersion: "17.12.0.001",
      revision: 0,
      image:
        "ghcr.io/supabase/cli/postgres:17.12.0.001-r0@sha256:eb8b9d25ae5aa1a8d418cc040450f96cfa4aae1f7f1bb1178f8ee571683824bd",
      upstreamImage: "supabase/postgres:17.12.0.001",
      natives: {
        "darwin-arm64": {
          archive: "f896d72354c5bd9d4d2c716b3f6a5724cf0e788eb21e9485b4fff9e25bde9097",
          manifest: "d3fd99710d925f62afe08eb290bd7ebcca6a7dcd8285863b7f0bc2de2c9052ec",
        },
        "linux-amd64": {
          archive: "8c882b70cb635a3c8439f427ac52b0e96eb95aa4eae344415df5d5beaef0b6f0",
          manifest: "38e807f14954b049e0f1d591b6e2b958763327edacf3563e12671fabe09ea345",
        },
        "linux-arm64": {
          archive: "938b995f6184cca65d20e8a9632c5411c9950b2819fc89b542fe7c4be3449f1b",
          manifest: "5e145b56915506106584a72db67706512225231cf0e43e97172237dff6bfdbbb",
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
      "15.20.0.002": {
        upstreamVersion: "15.20.0.002",
        revision: 0,
        image:
          "ghcr.io/supabase/cli/postgres:15.20.0.002-r0@sha256:8d1ce70de3b823f323d40bcc7758c2e811c513d15d5555fb98f0d421d3b8809e",
        upstreamImage: "supabase/postgres:15.20.0.002",
        natives: {
          "darwin-arm64": {
            archive: "29de9659cbd476ccbac7bb1aed35d5cdbb576cf9d6a8250edc3425ee5f24627c",
            manifest: "58ebe57500718e2067c60dfafcf596c28709deec6b95c259c78b2d4561292735",
          },
          "linux-amd64": {
            archive: "17b5891fbdba908aa5e9ee9b3d7497d1fcd9cacaf3ca99c80ea86ea55b4a1006",
            manifest: "2d376523ba2c4b6a991806650501148322f5ad76f5da0001c67a595085a1a976",
          },
          "linux-arm64": {
            archive: "43a58c9e175e21475a606c78e210e769f648506b93749682f56d4e54a974d7eb",
            manifest: "dc79599774569a6e3ebba5427f9de8c376f266e8447e1a0e15b64120cd6e9229",
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
      "17.11.0.014-orioledb": {
        upstreamVersion: "17.11.0.014-orioledb",
        revision: 0,
        image:
          "ghcr.io/supabase/cli/postgres:17.11.0.014-orioledb-r0@sha256:84b387ecc92f0620e3d631664407e8a47a0458614b389819fcf26cc9a13f5c78",
        upstreamImage: "supabase/postgres:17.11.0.014-orioledb",
        natives: {
          "darwin-arm64": {
            archive: "51e16bea69ab5383da314b6c765274d9eeb774b0ea44afc1332f7f8bb0750a7d",
            manifest: "df51d1aa8967a3e649d936cc5e626c4825e8b6dee2e8a608d439b6c1d94f4f8a",
          },
          "linux-amd64": {
            archive: "613919ab34b9fdd176823fc81d56cb22d4122375bd7cab90be8e1d067e23e2a7",
            manifest: "35c45eb73eef8c44ca101aafa19729d386907c1463bd1a7c176ed3f167f56a4c",
          },
          "linux-arm64": {
            archive: "45288a3cdfc37d26ee577b334cb3c1df8a71e45ae3b225054e374f1521c65751",
            manifest: "740f056ce4fa7a5711f9daa9f7d5ad7e97f90209275ad6a9d4094563defdf04e",
          },
        },
      },
      "17.11.0.016-orioledb": {
        upstreamVersion: "17.11.0.016-orioledb",
        revision: 0,
        image:
          "ghcr.io/supabase/cli/postgres:17.11.0.016-orioledb-r0@sha256:2286b11ef44d36af9bdd18b9043d9e7ba37b414541c10d60bb3a9688e6ce1949",
        upstreamImage: "supabase/postgres:17.11.0.016-orioledb",
        natives: {
          "darwin-arm64": {
            archive: "e7f046cdc2b24f3bb4b0593f64b2d30bd4d85d33fa8aa5b2e86eaf0e38a586e6",
            manifest: "dcf0aaa6134cd1276147fae8faaa0011bd90f6b89440cb7f3f188aadd0dd5f1a",
          },
          "linux-amd64": {
            archive: "32f4b9e5fcf241ccdcb4b59811a61fe0f37103b559f88f60e0802d06e0a540ba",
            manifest: "a2ca6468c7ab885df87ff5285413146a7ce1fb0f0ca78825832d0c1feb839f70",
          },
          "linux-arm64": {
            archive: "62345e735463eb5f5910b729075278a28f1988d95e985047794b1801ec4ab0e7",
            manifest: "321c5069a28a819cbf938ea5859f63e81e7698cbb10a5c9c0fb213d2844f88a8",
          },
        },
      },
      "17.11.0.017-orioledb": {
        upstreamVersion: "17.11.0.017-orioledb",
        revision: 0,
        image:
          "ghcr.io/supabase/cli/postgres:17.11.0.017-orioledb-r0@sha256:21e4be21bff828cf4164de76b526d695a5f58c7ba7bfeb152fc7a2065e82c9d1",
        upstreamImage: "supabase/postgres:17.11.0.017-orioledb",
        natives: {
          "darwin-arm64": {
            archive: "99055a53bd70fd72f5b42edf507f2f97fd9e1fcad85839f34cfb7958e5757752",
            manifest: "b0dee24eb192969ec1dd2fbeca6f1f68f03e0a3f5760bd4b862796d4b7500bd1",
          },
          "linux-amd64": {
            archive: "055f40a1bd648fac00d520f13e27a0b399f0495a327e89f3c3a02fdc462f4330",
            manifest: "e284e1fc51a301cfb34866c31cd51224ca8d2adbcbbe96b3c7453530ff4d1b9f",
          },
          "linux-arm64": {
            archive: "14baf5cfc84330a64e04f7ce28762a60dcde8fcff41bef85ce4c6491b3c7daf4",
            manifest: "63f5b996fd842560f33b499bc36b0f8674cac2ab5b8941db22066f5b35ee6420",
          },
        },
      },
      "17.11.0.018-orioledb": {
        upstreamVersion: "17.11.0.018-orioledb",
        revision: 0,
        image:
          "ghcr.io/supabase/cli/postgres:17.11.0.018-orioledb-r0@sha256:5f160baf2fc9eb544aafa8dd33231a611d5c725242f0ecb89c41a422f35e3335",
        upstreamImage: "supabase/postgres:17.11.0.018-orioledb",
        natives: {
          "darwin-arm64": {
            archive: "ea145998919ee892a0f1b7d52163ba4d3665acc492a033f250a0de76b44886fb",
            manifest: "c096a92f791110c000932877e1b6f83455a82d2da8cf9d7c273cbbbc8952721f",
          },
          "linux-amd64": {
            archive: "eb715a98ed54059ca67fedf0c1bef6d8dce8e33d964d10531bce56dbe061459c",
            manifest: "ce76378b7b29c3f47e16f70918e9357193eb229ef4cb30edb3a5c38b0fc3db03",
          },
          "linux-arm64": {
            archive: "b8077d9a167a8341444d3185dbcb3cf57d5768f179ab7082740ba64d75925feb",
            manifest: "57cbddaca5c392325b570c4e1f8166dbfce32c8e31ab0ad49d7fd88ce634d1d7",
          },
        },
      },
      "17.11.0.019-orioledb": {
        upstreamVersion: "17.11.0.019-orioledb",
        revision: 0,
        image:
          "ghcr.io/supabase/cli/postgres:17.11.0.019-orioledb-r0@sha256:5911e8f3d001153046fd0177ebeabcf9772b1a4d5478f8bfd9bc6e1a4bd64b62",
        upstreamImage: "supabase/postgres:17.11.0.019-orioledb",
        natives: {
          "darwin-arm64": {
            archive: "0e9635a6a41fede0f55cb938064d97321f0be722a910ee3637b9e55d4cb97515",
            manifest: "5bf57accc77cb26f64994b528cc35abb2e641f48e55508c0d7db6e7abeebb5d7",
          },
          "linux-amd64": {
            archive: "11d04a2e30b660eadda15215be05647551ab93830fc40f03b897b8e12561d0ca",
            manifest: "726235ccb391875b784f6848a3867da3a4aceb242e463449012942c4ffcfe550",
          },
          "linux-arm64": {
            archive: "507164e13269da078fa51cac6050780989a5db11f4ffd0bc2e901f59cc2ab2fb",
            manifest: "f37fa08776d655e21fc783db8f90c46ce5ff99a896d49cf3c9df6acacc7eae2c",
          },
        },
      },
      "17.11.0.020-orioledb": {
        upstreamVersion: "17.11.0.020-orioledb",
        revision: 0,
        image:
          "ghcr.io/supabase/cli/postgres:17.11.0.020-orioledb-r0@sha256:b33445efd7ddc0c94dc26dd3ad8597079c90b363f254b13f1833add645351da6",
        upstreamImage: "supabase/postgres:17.11.0.020-orioledb",
        natives: {
          "darwin-arm64": {
            archive: "b0efe12e1405bdbdbb5636b1dfd6d09bfe90d8fa34f4534cd31b2e033c5f7383",
            manifest: "77798d92b31a3242668b3c9359cdc682841834bc25357639812eeffa31feb0a0",
          },
          "linux-amd64": {
            archive: "1c093918f3def10f89a6e34a88ae61142875a76e4d330899c32017ef63b5f6e5",
            manifest: "6539bb4a636a9bf98e21c2e07774c2683b87543b2e494f323f998631b8d4269e",
          },
          "linux-arm64": {
            archive: "dc9de32ba71aad9990d95362d617be3d6d3ec1d05e257c1029d33df736c7f7c1",
            manifest: "a6e240afb2e8afdf2cadd2f384b64869018b90cff939b2a24d47e887665014a9",
          },
        },
      },
    },
  ),
  rest: definition(
    "postgrest",
    {
      upstreamVersion: "v16.6",
      revision: 0,
      image:
        "ghcr.io/supabase/cli/postgrest:v16.6-r0@sha256:f710c9f38dd5e1f7d071a28b458cf45dbdfb760a9b50b8013375fb1e8bdbf521",
      upstreamImage: "postgrest/postgrest:v16.6",
      natives: {
        "darwin-arm64": {
          archive: "479bac83f1d542517e9505f8e54927cde278e660b6414a689f67e2a22bafd9f5",
          manifest: "e4a178de6e6cb228475b4aa7f8b8c35a9c619a967387f3f96fe88809e00cb5b9",
        },
        "linux-amd64": {
          archive: "78c3b6bce995699b527564ae1fd8fd7d7d89378b78570a6778151b49be06c53b",
          manifest: "06a7c695db373d778656294d7580508672b8fe99c28b847ea62d5499a8848b01",
        },
        "linux-arm64": {
          archive: "ce885bf5bd0f778d2f1fea888a69986fd3046769fede67b0d1f639a051ad45fb",
          manifest: "9fc513a676a0af6e0bd59538a207f62b76f6bcf9ee299c56965ef07eb163a9ba",
        },
      },
    },
    "bin/postgrest",
  ),
  auth: definition(
    "auth",
    {
      upstreamVersion: "v2.198.0",
      revision: 0,
      image:
        "ghcr.io/supabase/cli/auth:v2.198.0-r0@sha256:6119529b17c2b335fdeb49673cbb5d602bf5e4368d1f1032ba11bc4bfd24b850",
      upstreamImage: "supabase/gotrue:v2.198.0",
      natives: {
        "darwin-arm64": {
          archive: "323bb22d7a163702df4ad0f0b4fb49771a9bb08d49763f7fdd495ba4f745710a",
          manifest: "e2f17c664c8afeed99713820bddd5ed7e9433b8a4e19e9a4e1c1fd10754604d0",
        },
        "linux-amd64": {
          archive: "4950efb44baf7fd8dda6198f1b866be643832f1096adeb67bb2d864572e4174a",
          manifest: "0bc00fc89511098819ce1b05a9b6c30dfe383fe2bae4c527de27b04a462f8667",
        },
        "linux-arm64": {
          archive: "14850783b8a92eccec16f1b193b913c85489abf29345f94acccceb9b93b41c08",
          manifest: "6eb8e2abbd275d0633683fbea4e5fc00c183995c3eca8a2c2820c40b5b40dcbd",
        },
      },
    },
    "bin/auth",
  ),
  realtime: definition(
    "realtime",
    {
      upstreamVersion: "v2.172.1",
      revision: 0,
      image:
        "ghcr.io/supabase/cli/realtime:v2.172.1-r0@sha256:720b771e56dd98b9f1714d69b9b3cfde9d214f9b445f4e46ed33fc1b8ecaf0a1",
      upstreamImage: "supabase/realtime:v2.172.1",
      natives: {
        "darwin-arm64": {
          archive: "22181f37a047d02cfe1d40e358d4539af862a54fd3fa771d35e4b323136eecd9",
          manifest: "01ccbf372e8a98055f6140454bf689380c11cbfb7cecc4df83840decc54bc03a",
        },
        "linux-amd64": {
          archive: "2f5a7aa58e09e0c294c9887332c926a4a9e77fb4b5a673e071ff9d19f8a59bf6",
          manifest: "1a05f78f54e21f46236bacae2cbd5504a90972580206c2576b36d0410c736127",
        },
        "linux-arm64": {
          archive: "6ee83173e6238db06a670fccbfd4c009c70b5cf5c866d15f8682f4fcd822980c",
          manifest: "8cac7037fa07b6f6e294cb95a5b9a9fbc11eab94ca655081679a147d84c64483",
        },
      },
    },
    "bin/server",
    ["bin/server", "bin/prepare"],
  ),
  storage: definition(
    "storage",
    {
      upstreamVersion: "v1.98.1",
      revision: 0,
      image:
        "ghcr.io/supabase/cli/storage:v1.98.1-r0@sha256:6be259b6f4c899339c1df88a1a5ed29e6e633df8f47aa83825a5068634cbc152",
      upstreamImage: "supabase/storage-api:v1.98.1",
      natives: {
        "darwin-arm64": {
          archive: "190f4f1fab47b963092dcbeee5c2655e017512de5a6f51ed653c54c2361b56b5",
          manifest: "fed47dda1f863d9cdf8946531e85c21b3f82c4ea70eda71cf806695c7fe5c43a",
        },
        "linux-amd64": {
          archive: "6c02bdae26adc77fb32d2fcb65a3472f9bddb12bd31026b980bce387f2347525",
          manifest: "ae21ac354bba2c90e5084d6eaa871e9bfd1846e9dafd9a2d69c4680c3c218ac0",
        },
        "linux-arm64": {
          archive: "8af3e4ef7950128e565352094bd697291de2fc35b702a96e0671d9580153738a",
          manifest: "3cadef32f50c9a6953cbc319e306522c602f9dcca68119affc20685bd83ea9a7",
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
      upstreamVersion: "v1.79.2",
      revision: 0,
      image:
        "ghcr.io/supabase/cli/edge-runtime:v1.79.2-r0@sha256:4f525c8c98a4f3991558c01ca887186bcdc060c77653a45419f25c352d9ddc41",
      upstreamImage: "supabase/edge-runtime:v1.79.2",
      natives: {
        "darwin-arm64": {
          archive: "4140c12c504290e507bf8b1a206f3ad1e4f31a8114eecdab4e140a758d965431",
          manifest: "bf1bd1ff7ea310ad774b14637347a87aa7db0b8e755e140a9b6471fc25ef3d6b",
        },
        "linux-amd64": {
          archive: "c8c66adb190b1da3a5f003447a5dbec47322571d2688797620b443caded71959",
          manifest: "2c162aa8e610fe98fd5f933da9968b1b718fee47e784ff5f9b64f83852252f4e",
        },
        "linux-arm64": {
          archive: "8bbd8cc97b65b5edf3a85a34c21a58b0660b4e6213edacb2db0a1e7ef1c42171",
          manifest: "3646afe17bb3e4d894b7875d1090dbc7350d61cf4153209b1a64cfb9444573ca",
        },
      },
    },
    "bin/edge-runtime",
  ),
  studio: definition(
    "studio",
    {
      upstreamVersion: "2026.11.16-sha-51bd16d",
      revision: 0,
      image:
        "ghcr.io/supabase/cli/studio:2026.11.16-sha-51bd16d-r0@sha256:89ce7a6ce461caea358e82113204f7af411447003d0ccbd49b340c7e81896c96",
      upstreamImage: "supabase/studio:2026.11.16-sha-51bd16d",
      natives: {
        "darwin-arm64": {
          archive: "dd6e5faa76e228f96bd83ff48224ddc5c152de5ba9bcb8ccd2556e684654ca96",
          manifest: "5703ce88a7094851a91dc5edd6702ff892c6e121f0ef488f9e63fe48cd5c45db",
        },
        "linux-amd64": {
          archive: "f801457ce795aed4239aeb7ee41b2765878a28b39d10b18eb6b454b719a3b150",
          manifest: "8f8afc823b1eb470cbdd99534faf7c570845860104a1eaab48b6b230ad200459",
        },
        "linux-arm64": {
          archive: "62c594d7a6460d0ee60b628f254a6182655d7edab2f7d4f03ae999a10e8e9fd0",
          manifest: "cb9da77f04e733cdbc682fefc195b14dc0f69b0047a8dd972eafcabb6af408af",
        },
      },
    },
    "bin/studio",
  ),
  pgmeta: definition(
    "pgmeta",
    {
      upstreamVersion: "v0.100.1",
      revision: 0,
      image:
        "ghcr.io/supabase/cli/pgmeta:v0.100.1-r0@sha256:325d05d3feaab6ea5f1f7c08a40fecd504a37aef3b754a6587f9b0bbc7de7c75",
      upstreamImage: "supabase/postgres-meta:v0.100.1",
      natives: {
        "darwin-arm64": {
          archive: "48572c4ac9790c2b79441dfd49afd6949361b5ae8fe58bfa39424938a235563f",
          manifest: "9795f8d37108b180f90ff17c88a2c3e1c1987ac90edf545d0450805dc4e26b0b",
        },
        "linux-amd64": {
          archive: "f0801bca07e60da4b0e20f6ca90a00064d9fa9f422f345ace7340a7fb791cf2a",
          manifest: "af6de52e42ad39462a94a327749a4929a298eb075f338740a37a681eab7b21fd",
        },
        "linux-arm64": {
          archive: "d38e8dd8aeee659c6899ddf657fc672a97fdf5a5d8e04b1152733dbb69a0fede",
          manifest: "75077279a1aac3c46e28e8c84dc02ae7e10b87fbed6f1b2d571714226dbea7ef",
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
      upstreamVersion: "v2.10.1",
      revision: 0,
      image:
        "ghcr.io/supabase/cli/pooler:v2.10.1-r0@sha256:3ed8759dd8066718df6be496b84ed6fc1a61f2268e7013f10a49cfb16072cc86",
      upstreamImage: "supabase/supavisor:2.10.1",
      natives: {
        "darwin-arm64": {
          archive: "cb9f4f6330b32376bf7a2cf6e6c8c3bafb0059645685b9273fff8cdd80b6bfdc",
          manifest: "9fbd6b9ab5d7082078a387c515c7bed4fb1cd9bbc607908f53531a3acbb809ee",
        },
        "linux-amd64": {
          archive: "ee81448917e4e95aa2748c36b960b0e9ea9a39a1618624f15cd10aa81b9d68c3",
          manifest: "1e6318d4b8ba56455ed8b57562286f9f2730dad0c72fc60aed7428d92fa6e625",
        },
        "linux-arm64": {
          archive: "e853eddbb2065e0a51c506f2d9e33ca08f427d28cb712adb351c25a29485f7c7",
          manifest: "f6489fff3137ac2d5f55698143006da155e9bf7925a7efc33ce6c833b4bb0a26",
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
export const SLIM_NATIVE_SUPABASE_S3_MIRROR =
  "https://supabase-cli-artifacts.s3.us-east-1.amazonaws.com";

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
