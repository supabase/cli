import { Data, Effect, Path, Record } from "effect";
import type { StackFailureKind } from "./FailureKind.ts";
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
  readonly kind?: StackFailureKind;
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
  /** The generation's digest lock file; a native workload spawned from `root` pins this too. */
  readonly lockPath: string;
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
      upstreamVersion: "17.11.0.004",
      revision: 1,
      image:
        "ghcr.io/supabase/cli/postgres:17.11.0.004-r1@sha256:8fb7ae7cd0d8121c460c8756d7f2791ce9a19c3331b46987456dfa4f8b45d701",
      upstreamImage: "supabase/postgres:17.11.0.004",
      natives: {
        "darwin-arm64": {
          archive: "4c5b550683b8835a1a5ca0bf8ba73b6c1fe0cb8b2484dbfa15f32f76eade7efb",
          manifest: "0f53b023b5afb14b759705661e88af450f634df4584eb5ffd3de0ede32119b44",
        },
        "linux-amd64": {
          archive: "a9d374c950ec50cb59ead868662f0dd44d358b3917a10346b4bf131f567207f7",
          manifest: "368ab96c35d21b3505966b4d892ebe3fe8247335ea75873bc0bbd1881e968459",
        },
        "linux-arm64": {
          archive: "6c7dfb5adf4b443a6af472bad8906ac9677dfe8310b0d598bfb101844095bcf5",
          manifest: "f0e5cbf7aee20f175a845251652b2c4f761d914941914df483ee2c20d104eb0e",
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
      "15.19.0.004": {
        upstreamVersion: "15.19.0.004",
        revision: 1,
        image:
          "ghcr.io/supabase/cli/postgres:15.19.0.004-r1@sha256:df77a34bf5839149c74b24a12228ad58e492c2a9d76d3887ef4f279d06173e09",
        upstreamImage: "supabase/postgres:15.19.0.004",
        natives: {
          "darwin-arm64": {
            archive: "57463faeb424d11296a833ea271881ba4ab31434ec90b860b104e2e814de25fd",
            manifest: "7a0dab606017ccfea22f1e32f69b78792f3ff5eca13e3880a3de8884e9c03832",
          },
          "linux-amd64": {
            archive: "867fba08024fb813dcbd8d0cfcc87f02dfb49d6093e18a9459a6f4c1b44236c2",
            manifest: "eab1b6d62684aef3f7d3aa9e55b9e8dbf99f732e4ac23f704e75474321bdfa30",
          },
          "linux-arm64": {
            archive: "73502a47bb7419f70668feeb857fe2da039fdaade60a7baba41b1edb954b2796",
            manifest: "3b957388f0bf05c230b1d65691412150239aa39847e0d782a1448d56258f9ef8",
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
      upstreamVersion: "v2.143.0",
      revision: 0,
      image:
        "ghcr.io/supabase/cli/realtime:v2.143.0-r0@sha256:25e384565841450dc0b89ab05812140b230f1939c502568cdef927e59eb74e55",
      upstreamImage: "supabase/realtime:v2.143.0",
      natives: {
        "darwin-arm64": {
          archive: "37c8e96279ba9c07f645e248edd21d4372fc4e8682db14df7a9067e64771a2f3",
          manifest: "7bc4ecea682517d210ecd0967b98eb0c344312377bc7b3a3bd35aa016dcb41ad",
        },
        "linux-amd64": {
          archive: "072880dd2ebaa6631d3ed305214553ee842caf066ef4399867a9b75c757b6d42",
          manifest: "125fda1d857cb5df1646629a8cd75d1b5b97d755bcc80ba5cc891484eec17078",
        },
        "linux-arm64": {
          archive: "36bb8a999e630242487091330239494c9e2178d59d5583e960f6f5aa34844f1b",
          manifest: "9f42666be7fcf3ab3564c47ddcabd0edc5a0aafac4d4990aaac0a47eacc7d5e4",
        },
      },
    },
    "bin/server",
    ["bin/server", "bin/prepare"],
  ),
  storage: definition(
    "storage",
    {
      upstreamVersion: "v1.80.2",
      revision: 0,
      image:
        "ghcr.io/supabase/cli/storage:v1.80.2-r0@sha256:b3ad9f9bac0ab8202bdf9634b717faba0b95ff9207dcf7fbc7d4b4f82e696f7f",
      upstreamImage: "supabase/storage-api:v1.80.2",
      natives: {
        "darwin-arm64": {
          archive: "bf10245a3c91dc921f996526a30ae5ecdcb1a848fcc2e1f36e87c6665993cd60",
          manifest: "0a23dc0bec07b4c3ddb474abed91df391fd23eaa2f3007d9f50bb3f1b4a891c5",
        },
        "linux-amd64": {
          archive: "a6761be778a8d97b4fa513df971101e056d471f88403befc2d5fe688057d2d25",
          manifest: "14787eda20a311e6dd8f0a437aeba0b4e95fbd741f1f620c5d236ac8c5f1563d",
        },
        "linux-arm64": {
          archive: "e5a28a52f676a97ed5f93c241edf5c2bec30290d5f39000388b6ad3728702e55",
          manifest: "9db21d0bded2d71988caf2db6518e48080adf27c1c09f42ee69dfe5ec02e132c",
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
      upstreamVersion: "2026.10.05-sha-94b8b06",
      revision: 0,
      image:
        "ghcr.io/supabase/cli/studio:2026.10.05-sha-94b8b06-r0@sha256:a5580ddf689128fac853f3fa1b122414b78a64f9a4af0194ef4caa2a387aae5f",
      upstreamImage: "supabase/studio:2026.10.05-sha-94b8b06",
      natives: {
        "darwin-arm64": {
          archive: "01613b298673ee5829b5847da72105b5dbe7206b80482fd05bc17619c21901b9",
          manifest: "1eb8a29d6cf67a6b0de0d76dc89840aff6022d56fbf2a7dc20634c541fa50c4e",
        },
        "linux-amd64": {
          archive: "3c7c87ddd859979a5b441e2a7abfe462c4864922818b8dda3fd013bced73337c",
          manifest: "77adf4f7a45510a4fd807056cce1ba54b35285001e9b87e556774902aeaff33c",
        },
        "linux-arm64": {
          archive: "c663e88999d36ad587df2d56ede2e6cdaefbbb8011f9369b075500606effea03",
          manifest: "c62ff9c6779a3e92964b27ee9430d60f0e12b54d201dc53b870942c1ee926ff4",
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
      upstreamVersion: "v1.52.0",
      revision: 0,
      image:
        "ghcr.io/supabase/cli/analytics:v1.52.0-r0@sha256:f2e3b54f41a42f8f422cec15382be390c986fe5a121d1345bb28c918291f9517",
      upstreamImage: "supabase/logflare:1.52.0",
      natives: {
        "darwin-arm64": {
          archive: "385c0613b70e65b81266f469e5be9d12d4cc8fc06fe3ac6424a3fb59ebb387b2",
          manifest: "f3cc90f649b6c84f31f185984c47232f75247eda19031c179d80f88bc8a3e6ab",
        },
        "linux-amd64": {
          archive: "bb2d8071b965eb8e6e055e6ea176824e94ee0f570cbc583d302c0ffe96bb683a",
          manifest: "692a90984395c3b7a076c8804daf4709f65cee768dc71256061ec2a1c349200b",
        },
        "linux-arm64": {
          archive: "d004f392e1db41b63dacc19a7afc42981ab8198ef2b8fa27f81eebd6cde9bcee",
          manifest: "25010eb91632bfa7b0be1bbc3caf713cc4c20572215c135dce957f285ba95ba6",
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
    return yield* new ArtifactError({
      message: `Unknown service kind: ${request.service}`,
      kind: "configuration",
    });
  const selected = definitions[request.service];
  const version = request.version ?? selected.defaultVersion;
  const pin = Object.entries(selected.pins).find(([candidate]) => candidate === version)?.[1];
  if (pin === undefined)
    return yield* new ArtifactError({
      message: `Unsupported ${request.service} artifact version: ${version}`,
      service: request.service,
      version,
      kind: "configuration",
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

/** Builds the native store request shared by ahead-of-time preparation and launch-time use. */
const nativeStoreRequest = Effect.fn("Artifacts.nativeStoreRequest")(function* (
  request: { readonly service: ArtifactKind; readonly version?: string },
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
  const sourceArtifact = artifactFor(request.service, resolved, target);
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
  prepared: { readonly path: string; readonly lockPath: string },
  path: Path.Path,
): PreparedNativeArtifact => ({
  service: resolved.service,
  version: resolved.version,
  root: prepared.path,
  executable: path.join(prepared.path, resolved.executablePath),
  lockPath: prepared.lockPath,
});

/** Ahead-of-time: downloads and publishes the generation, but pins nothing. */
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
  request: { readonly service: ServiceKind; readonly version?: string },
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
