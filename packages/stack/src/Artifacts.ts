import { Data, Effect, Path, Record } from "effect";
import { makeArtifactStore } from "./preparation/ArtifactStore.ts";
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
}> {}

/** Lowercase hexadecimal SHA-256 digest. */
type Sha256 = string;

/** Content digests of one native target's published archive and manifest. */
export interface NativePin {
  readonly archive: Sha256;
  readonly manifest: Sha256;
}

/** One published slim-services revision of an upstream version, pinned by content. */
export interface ArtifactPin {
  readonly upstreamVersion: string;
  readonly revision: number;
  /** `ghcr.io/supabase/cli/<service>:<release version>@sha256:<digest>`. */
  readonly image: string;
  /**
   * The exact upstream image this release was built or mirrored from, as slim-services recorded
   * it: the release manifest's `upstream_image` for a derived service, or the release's
   * `oci-provenance.json` `source` for a mirrored one (vector, mailpit, imgproxy). Normalized to
   * the Dockerfile's `FROM` form — no leading `docker.io/`, no digest — so legacy non-slim mode
   * can use it as the upstream tag directly.
   */
  readonly upstreamImage: string;
  readonly natives: Readonly<Record<NativeTarget, NativePin>>;
}

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
}

interface ArtifactDefinition {
  readonly sourceService: string;
  readonly defaultVersion: string;
  /** Pins keyed by upstream version. */
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
  defaultVersion: pin.upstreamVersion,
  pins: { [pin.upstreamVersion]: pin, ...additionalPins },
  requiredRuntimePaths,
  executablePath,
});

const SLIM_IMAGE_GHCR_REGISTRY = "ghcr.io/supabase/cli/";

const definitions: Readonly<Record<ArtifactKind, ArtifactDefinition>> = {
  database: definition(
    "postgres",
    {
      upstreamVersion: "17.11.0.002",
      revision: 0,
      image:
        "ghcr.io/supabase/cli/postgres:17.11.0.002-r0@sha256:5a551a204a41267c4f78a2e5b34657f5c6fdd39eddccd50262466481b95739cc",
      upstreamImage: "supabase/postgres:17.11.0.002",
      natives: {
        "darwin-arm64": {
          archive: "10410e402c77210a0543539d9bafcabd0c04923d8e796928cbd2a053cf7b4f4f",
          manifest: "6c1f236324f02baf472152aafed68884cb115b3979fbf1c49209717485d36ac2",
        },
        "linux-amd64": {
          archive: "4a4410791bdeeda2e08fda400039b4319bb26d74e08e68951f38abc9dacd7c26",
          manifest: "cd76249031db380831d773acea6fea8a54104d5ca97bb18db34d05e7bd124e5f",
        },
        "linux-arm64": {
          archive: "1d54954b2441990643f25a825e4e46ec50ecf538a63baa8e413e353e7faeb939",
          manifest: "8dda36ffdb7b5b501873ff41c265bb061e8eb9aeed0e4372c5ad9af59110776b",
        },
      },
    },
    "bin/supabase-postgres-start",
    ["bin/supabase-postgres-start", "bin/pg_dump", "bin/pg_dumpall", "bin/pg_prove", "bin/psql"],
    {
      "15.19.0.002": {
        upstreamVersion: "15.19.0.002",
        revision: 0,
        image:
          "ghcr.io/supabase/cli/postgres:15.19.0.002-r0@sha256:a3f343f19323497a5766fa4e86a51dba495a8eca354cc128d879b4632c6bd017",
        upstreamImage: "supabase/postgres:15.19.0.002",
        natives: {
          "darwin-arm64": {
            archive: "59b05ca76db9d807803840264d885a5ff435e552f294d7f22ca831fac1ffb4a3",
            manifest: "b7956520ee15a8265635cabb318490f89c4737706f9349246da9921a17fbac07",
          },
          "linux-amd64": {
            archive: "bdf565e0b866ca7b2494b56b502963ef57d54ab1c99eac6855f760caaffda712",
            manifest: "e1ecda082f1c414fea6356d0399eaf76d22a25b96808961a945aacb242f904c9",
          },
          "linux-arm64": {
            archive: "c7420f0eb0938397d90906265630359313936cc576035cb31c2bdef6451565c6",
            manifest: "207feac260bcbc5607decca9e14e0422accc4a0ae1f7d24b8fe0992d284cc43c",
          },
        },
      },
    },
  ),
  rest: definition(
    "postgrest",
    {
      upstreamVersion: "v16.4",
      revision: 0,
      image:
        "ghcr.io/supabase/cli/postgrest:v16.4-r0@sha256:63a8d4acfdeb107b6568f4582759c78072100ef07951a7fbe58c9a51241138a7",
      upstreamImage: "postgrest/postgrest:v16.4",
      natives: {
        "darwin-arm64": {
          archive: "a1f5449d739404cbd042ec9dbabadea6dcf810db636e44c7176b859d5e78ab07",
          manifest: "943cbeb7a3cf2f9dd0406152a178d814e81221d0061626b04ab2b042209d5e03",
        },
        "linux-amd64": {
          archive: "d9170378062dba1188c25fb05cd08a3397bb62afd63151812f831eed4fab1051",
          manifest: "a3f3f29c4c4c5f7b004b507152f29316bc79df052652fb00ad5ad9bdd6f7be29",
        },
        "linux-arm64": {
          archive: "c1a99eddaac0c005b2520960d258c7fc79945ba0703eff3a2515aa119fac4477",
          manifest: "7ced80e3f814d9748763983de74706c6e04a897f8c024366af156c8093cf150f",
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
      upstreamVersion: "v2.140.7",
      revision: 0,
      image:
        "ghcr.io/supabase/cli/realtime:v2.140.7-r0@sha256:ad135917b87f7e0056d87d0ddc97e5a39a7711852f4ea6ec4b3f260a47d79927",
      upstreamImage: "supabase/realtime:v2.140.7",
      natives: {
        "darwin-arm64": {
          archive: "5f3ce154d15384b358a872db65b4e25475238816838e0fa767a97336ca6364a8",
          manifest: "63758ba9c6b4899929f4d5ba33961f1e1746460d916bf7e27f3202bdd80fb1a8",
        },
        "linux-amd64": {
          archive: "f6746785a4940a40b72ad94514e0836a89a760c819e39e5bbebce567ff5d3a88",
          manifest: "8af0cc1aa5770e54ed04b2d7c510d9f6ae59928d3c39a77e8e41b11aac89301e",
        },
        "linux-arm64": {
          archive: "3b0764ded78e46c242979a0598743a92aa41649858742b80bfb572998a55b9c4",
          manifest: "f7d78dd862a46fab8f5f409ee00f5d8510e986137cd47705ace0bf39094fae9e",
        },
      },
    },
    "bin/server",
    ["bin/server", "bin/prepare"],
  ),
  storage: definition(
    "storage",
    {
      upstreamVersion: "v1.79.28",
      revision: 1,
      image:
        "ghcr.io/supabase/cli/storage:v1.79.28-r1@sha256:95e0007f273e7c990ab81c44e021e4278b8953dd95ae2fbdc19fca047d4bd470",
      upstreamImage: "supabase/storage-api:v1.79.28",
      natives: {
        "darwin-arm64": {
          archive: "bea019baff21e10b78291a9c23687ec15ebb45994d0d03c656ffda13e13108d4",
          manifest: "8612ea30b918ac6590f30660b518ea41b80d9d591734fa3313a64c6607621cb2",
        },
        "linux-amd64": {
          archive: "c8ce124acfe46a2151052f160a81653f751277516f5c378d93ba7f18e7b3efe4",
          manifest: "edce6bb24a84e5245956c1de3fa93d96d3813efbe2e5dac105b385ebae7e3f0d",
        },
        "linux-arm64": {
          archive: "8a51c2b8bc4d1076665321ae0da7eca81dbdff84dbc687a209a958955cf9cb69",
          manifest: "befaaec0e8660d99a4040f81ece4277e4db27812b8e2630a4d0b15d16b3ed831",
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
      upstreamVersion: "v1.77.4",
      revision: 0,
      image:
        "ghcr.io/supabase/cli/edge-runtime:v1.77.4-r0@sha256:33ca85830d726be1864e8ab929bf9e2230b0a750d59634fef871e736c9a40c34",
      upstreamImage: "supabase/edge-runtime:v1.77.4",
      natives: {
        "darwin-arm64": {
          archive: "c0a16266b5208caec6669a982076575492c46f4d999748cdb7f3eb1dccbd6e39",
          manifest: "ffa7bc574ead39237657cbc96308b750e8ddce778bf8072b6db8bf7a9f25e91a",
        },
        "linux-amd64": {
          archive: "29447f4e0ff992bce358fa3e08c4535e99c185d245a3e4c76efc4685aadadd18",
          manifest: "eead320333d0bb58c10a491c53e00c5076e983b2f5044a41036a54ee5d092188",
        },
        "linux-arm64": {
          archive: "f8b2b43ca5320729e25d8b455c8aaeef43c08ccddc764557c970c4e30a4d9fe4",
          manifest: "6b7257fca1bacecb4ca7c8f7512073109c8557672d8f9386533c483aa27320c4",
        },
      },
    },
    "bin/edge-runtime",
  ),
  studio: definition(
    "studio",
    {
      upstreamVersion: "2026.09.28-sha-5e59b60",
      revision: 0,
      image:
        "ghcr.io/supabase/cli/studio:2026.09.28-sha-5e59b60-r0@sha256:4cf4f70978bb0866d1644b43cb0d23acc4b4ef7a898592043ad0d13cad8059be",
      upstreamImage: "supabase/studio:2026.09.28-sha-5e59b60",
      natives: {
        "darwin-arm64": {
          archive: "37f420f6af3d5ee7dab884e8c39fe2c3bcddcee0d90e53d1e075a05ae3cb4b73",
          manifest: "b5d6209c4c28e594cc8b0ab961105465418f0021ba50a3fd92067ff5720ae820",
        },
        "linux-amd64": {
          archive: "19a9903732b71fba04ce342e4d13b83bf7579bce806981cf8f2b491ad792fc6e",
          manifest: "5a4f1e316ad84ff058263601b9b144177ab0cd18443e826354551aec88013199",
        },
        "linux-arm64": {
          archive: "ce69544c9ec5dbae50e5da731770bc199e12f0f1d63b22ec7a43b6a0ba00cb4c",
          manifest: "c27374ccc51cc6419f9bbd14f095f1a16db4bda369928effcc15a6366dcb3d1f",
        },
      },
    },
    "bin/studio",
  ),
  pgmeta: definition(
    "pgmeta",
    {
      upstreamVersion: "v0.99.0",
      revision: 0,
      image:
        "ghcr.io/supabase/cli/pgmeta:v0.99.0-r0@sha256:c19f6bba3ab66fcf30c8737d2361ec9f8e12a4fa8a071481f53366dc13e83340",
      upstreamImage: "supabase/postgres-meta:v0.99.0",
      natives: {
        "darwin-arm64": {
          archive: "337f8cc6a23d93f3f9cfeed12de2a86d686ce6f4346ff9b334b5dfdcba7e890f",
          manifest: "6b35ee42d334138562444842ed0662b97b3cbde504caa11e97407b137bc8b2ca",
        },
        "linux-amd64": {
          archive: "43156ba28901710bf02a333dc04c4b30754eb6a2334ff1d890a4a3ea55c02f22",
          manifest: "dbd8a7eac705b6c6df16826f22f3317906842be8498ce44fa1229ae6f16273ad",
        },
        "linux-arm64": {
          archive: "a8565d6e550efa8a8481c7d542b612e7a6d50668321fcd2e668b2ee9bcb28ed7",
          manifest: "1b67627c5ccde0f94a4997ab223a0ac072c70e9bf1bb86d3e4d0df42e90b4059",
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
      revision: 0,
      image:
        "ghcr.io/supabase/cli/analytics:v1.50.15-r0@sha256:cea1595bafa6ab32df4854d407261ddef6e35394e300ae29770ba48c49c8dc7e",
      upstreamImage: "supabase/logflare:1.50.15",
      natives: {
        "darwin-arm64": {
          archive: "336c78c501aff270b0fcd2a42229b76d9f2feafa646f49a59c3de29358e3de17",
          manifest: "d0e1a0c3fa0a4ebfcebbe490f290699424e3b8c92a542f50111ff88d6e47b8b5",
        },
        "linux-amd64": {
          archive: "a699ce1522dac43989987a9d152648ed0506fb887ffedff49c148da02cbbc7e7",
          manifest: "ba8c55eeb06be91ad582156854babdc6a06d7a26fa6956bc1271eee4cae9d536",
        },
        "linux-arm64": {
          archive: "bb977b9cd0623e1b1ece9875377fdf29577f96991d2e5c72a38a1b664c6a7538",
          manifest: "1739bbd4afb838e62b6191c4de8aa39685df9f5d83e1b7cc303bd096237ba08c",
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
      revision: 0,
      image:
        "ghcr.io/supabase/cli/pooler:v2.9.13-r0@sha256:3a32b56d03675ed24e84408afcbb12fa52b7ec6e7741f913770fea5b66c2ddd3",
      upstreamImage: "supabase/supavisor:2.9.13",
      natives: {
        "darwin-arm64": {
          archive: "c05285be2a945a29d5be491661926f8c88d976540d49ddbcab10aa7276b29934",
          manifest: "0fafa8dcf601ff3cea7326e82f7a5191ffe03e3e4edd0d2b155e80e8c9f53d78",
        },
        "linux-amd64": {
          archive: "d94e36f44267b4159fa55e1aea39320a68789b6af07f9cc87c27327ed6a00602",
          manifest: "4f181d1d25da91f72ca37c22cdc46278a424a4edef6bdd2ea2c30f463c629a5a",
        },
        "linux-arm64": {
          archive: "124f3e6c95e6ba985239e013cab76c5be28fbd92cb4986b687dd5e827f0525ca",
          manifest: "c6cdc298bc3a00d082a1c9c34f4131f13437df51fb0bf9a0ce857b0a2fd66460",
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

const SLIM_NATIVE_GITHUB_RELEASES = "https://github.com/supabase/slim-services/releases/download";

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
): SlimServicesArtifact => {
  const sourceService = definitions[service].sourceService;
  const releaseTag = `${sourceService}-${resolved.releaseVersion}`;
  const assetName = `${releaseTag}-${target}`;
  const githubRelease = `${SLIM_NATIVE_GITHUB_RELEASES}/${releaseTag}`;
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

export const resolveArtifact = Effect.fn("Artifacts.resolveArtifact")(function* (request: {
  readonly service: ArtifactKind;
  readonly version?: string;
}) {
  if (!Object.hasOwn(definitions, request.service))
    return yield* new ArtifactError({ message: `Unknown service kind: ${request.service}` });
  const selected = definitions[request.service];
  const version = request.version ?? selected.defaultVersion;
  const pin = Object.entries(selected.pins).find(([candidate]) => candidate === version)?.[1];
  if (pin === undefined)
    return yield* new ArtifactError({
      message: `Unsupported ${request.service} artifact version: ${version}`,
      service: request.service,
      version,
    });
  return {
    service: request.service,
    version,
    releaseVersion: releaseVersion(pin),
    image: pin.image,
    natives: pin.natives,
    executablePath: selected.executablePath,
    requiredRuntimePaths: selected.requiredRuntimePaths,
  };
});

/** Resolves a PostgreSQL major alias against the pinned database artifacts. */
export const postgresVersion = (version: string): string =>
  Object.keys(definitions.database.pins).find((candidate) => candidate.split(".")[0] === version) ??
  version;

/** Service kinds the stack runs, in artifact catalog order; legacy-only artifacts are omitted. */
export const artifactServiceKinds = (): ReadonlyArray<ServiceKind> =>
  Record.keys(definitions).filter(isServiceKind);

/**
 * Every catalog pin in catalog order, including additional upstream lines. `isDefault` marks the
 * pin `resolveArtifact` picks when no version is requested (postgres's 17.x line today); every
 * other pin (postgres's 15.x additional line) carries `isDefault: false`.
 */
export const catalogPins = (): ReadonlyArray<{
  readonly service: ArtifactKind;
  readonly sourceService: string;
  readonly pin: ArtifactPin;
  readonly isDefault: boolean;
}> =>
  Record.keys(definitions).flatMap((service) => {
    const { sourceService, defaultVersion, pins } = definitions[service];
    return Object.values(pins).map((pin) => ({
      service,
      sourceService,
      pin,
      isDefault: pin.upstreamVersion === defaultVersion,
    }));
  });

const artifactKey = (artifact: SlimServicesArtifact): string =>
  `slim-services/${artifact.service}/${artifact.version}/${artifact.target}`;

export const prepareNativeArtifact = Effect.fn("Artifacts.prepareNativeArtifact")(function* (
  request: { readonly service: ArtifactKind; readonly version?: string },
  cacheRoot: string,
  platform: { readonly os: string; readonly arch: string } = {
    os: process.platform,
    arch: process.arch,
  },
) {
  const resolved = yield* resolveArtifact(request);
  return yield* Effect.gen(function* () {
    const target = targetForPlatform(platform);
    if (target === undefined)
      return yield* new ArtifactError({
        message: `Native artifacts are unsupported on ${platformText(platform)}`,
        service: request.service,
        version: resolved.version,
        platform: platformText(platform),
      });
    const sourceArtifact = artifactFor(request.service, resolved, target);
    const key = artifactKey(sourceArtifact);
    const source = makeSlimServicesSource((candidate) =>
      candidate.key === key ? sourceArtifact : undefined,
    );
    const store = yield* makeArtifactStore({ cacheRoot, source });
    const prepared = yield* store.prepare({
      key,
      requiredRuntimePaths: resolved.requiredRuntimePaths,
      executablePath: resolved.executablePath,
    });
    const path = yield* Path.Path;
    return {
      service: resolved.service,
      version: resolved.version,
      root: prepared.path,
      executable: path.join(prepared.path, resolved.executablePath),
    };
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
