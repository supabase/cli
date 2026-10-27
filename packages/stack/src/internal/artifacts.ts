/** Artifact catalog and preparation shared with the CLI's stack-independent clients. */
export {
  ArtifactError,
  artifactServiceKinds,
  catalogPins,
  databaseArtifactPin,
  defaultRuntime,
  isOrioledbVersion,
  orioledbConfigVersion,
  orioledbPostgresVersion,
  orioledbVersions,
  postgresMajor,
  prepareNativeArtifact,
  resolveArtifact,
  SLIM_IMAGE_SUPABASE_ECR_MIRROR,
  slimImageMirrors,
  useNativeArtifact,
  type ArtifactKind,
  type ArtifactPin,
  type ArtifactSelection,
  type NativePin,
  type ServiceKind,
} from "../Artifacts.ts";
export { SLIM_IMAGE_GHCR_REGISTRY } from "../preparation/SlimEndpoints.ts";
export {
  ReleaseIntegrity,
  ReleaseTransient,
  ReleaseUnpublished,
  resolvePin,
  type ReleaseError,
  type ResolvePinRequest,
} from "../preparation/ReleaseResolver.ts";
export { prepareArtifactSelection, type PreparedRelease } from "../preparation/PrepareSelection.ts";
