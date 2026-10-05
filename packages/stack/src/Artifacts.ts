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
  | "vector"
  | "pooler";

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
  readonly service: ServiceKind;
  /** Upstream version. */
  readonly version: string;
  readonly releaseVersion: string;
  readonly image: string;
  readonly natives: ArtifactPin["natives"];
  readonly executablePath: string;
  readonly requiredRuntimePaths: ReadonlyArray<string>;
}

export interface PreparedNativeArtifact {
  readonly service: ServiceKind;
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

const definitions: Readonly<Record<ServiceKind, ArtifactDefinition>> = {
  database: definition(
    "postgres",
    {
      upstreamVersion: "17.11.0.003",
      revision: 0,
      image:
        "ghcr.io/supabase/cli/postgres:17.11.0.003-r0@sha256:9b5a006e5adc26d7b2fd8f2f794d812096d4a1760ac19978c6df88686d28e2ed",
      upstreamImage: "supabase/postgres:17.11.0.003",
      natives: {
        "darwin-arm64": {
          archive: "36ef4b0bd086dca961106b70454c6ce86324afe4914ddf1ef40dd8a0bf2162dd",
          manifest: "334516dbc311c8c370344646d54f74899b3f632faa84aacb59654698d427e9e8",
        },
        "linux-amd64": {
          archive: "876ff559afe9362f107a5f9b5ea46f4a931684251f6e3152d3e483a1bcc93942",
          manifest: "5d420eb125a8ea9f1c019a2b648ae39f42508d7859c7dbcb58a2dffeed90acb4",
        },
        "linux-arm64": {
          archive: "50e8a2308c3991ea2a92b3cb5f979244618fb9cd4d9f41d5594bff4a1f45f2fc",
          manifest: "d7f913c8adc55f433701787f86222e99802347dfbdbc3d7122bd7a9c270cde74",
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
      revision: 1,
      image:
        "ghcr.io/supabase/cli/realtime:v2.140.7-r1@sha256:898beb192146adbe2689e62154ec5c8e2a22c55e504592cf42f12698fb6b34ab",
      upstreamImage: "supabase/realtime:v2.140.7",
      natives: {
        "darwin-arm64": {
          archive: "562e5f101fab5d725aa8446ca2ba60ea602e4e8caabea184ff8c168e95a5166c",
          manifest: "0105c1910006e336e88a6cb6441bbfcf4b56f32ba239027fead8ffa9ce98958e",
        },
        "linux-amd64": {
          archive: "9b8d12d5ef5e4a79f755ab312847cd609561b9752317808804456ff648b7d7c0",
          manifest: "f1a7d9c7abe5a25728a6aff999ccd2dfec06d2da3b62c055bade24db8be560d4",
        },
        "linux-arm64": {
          archive: "cbafba128fbc3733c66d6b9d6567a7e3bc2bc1e6674160000d5c187345ccd63c",
          manifest: "db3f535d8087a68a23dde84612fdd5c1b881f1e6c8310f697f6cba9026c879ea",
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
  service: ServiceKind,
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
  readonly service: ServiceKind;
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

/** Service kinds in artifact catalog order. */
export const artifactServiceKinds = (): ReadonlyArray<ServiceKind> => Record.keys(definitions);

/**
 * Every catalog pin in catalog order, including additional upstream lines. `isDefault` marks the
 * pin `resolveArtifact` picks when no version is requested (postgres's 17.x line today); every
 * other pin (postgres's 15.x additional line) carries `isDefault: false`.
 */
export const catalogPins = (): ReadonlyArray<{
  readonly service: ServiceKind;
  readonly sourceService: string;
  readonly pin: ArtifactPin;
  readonly isDefault: boolean;
}> =>
  artifactServiceKinds().flatMap((service) => {
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
  request: { readonly service: ServiceKind; readonly version?: string },
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
