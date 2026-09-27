import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {
    assertSafeModelArtifactPath,
    ensureModel,
    resolveModelDirectory,
    verifyModelDirectory,
    type ModelProgressReporter,
    type ModelSpec,
} from "./model-store.js";

/**
 * Managed D32 profile identity used for planning and migration checks.
 * Real installation still binds the target MCP package's frozen authority.
 */
export const DEFAULT_LATEON_PROFILE_ID = "lateon_offline_quality_projection_v5_d32_v1";
export const LATEON_D32_ACTIVATION_POLICY = "lateon_context_v5_d32_owner_default_v1";
/**
 * Historical context-v3 rollout artifact. Its managed combination with the
 * historical `lateon_d32_owner_default_v1` policy is migratable by
 * `satori upgrade`, never treated as unknown D16 history.
 */
export const HISTORICAL_LATEON_CONTEXT_V3_PROFILE_ID = "lateon_offline_quality_projection_v3_d32_v1";
export const HISTORICAL_LATEON_D32_ACTIVATION_POLICY = "lateon_d32_owner_default_v1";
/**
 * Previous managed default (context-v3 activated profile + its owner policy).
 * The managed combination is admitted and migrated to the current default by
 * `satori upgrade`; historical meaning stays immutable.
 */
export const PREVIOUS_LATEON_CONTEXT_V3_ACTIVATED_PROFILE_ID = "lateon_offline_quality_projection_v3_d32_v2";
export const PREVIOUS_LATEON_CONTEXT_V3_ACTIVATION_POLICY = "lateon_context_v3_d32_owner_default_v1";
export const PREVIOUS_LATEON_CONTEXT_V4_PROFILE_ID = "lateon_offline_quality_projection_v4_d32_v1";
export const PREVIOUS_LATEON_CONTEXT_V4_ACTIVATION_POLICY = "lateon_context_v4_d32_owner_default_v1";

const LATEON_PROFILE_FILE = "runtime-profile-v5-d32.json";
const LATEON_ACQUISITION_FILE = "runtime-profile-v5-d32.acquisition.json";
const ACQUISITION_SCHEMA_VERSION = "satori_lateon_acquisition_v1";
// 71,577,202 bytes at approximately 128 KiB/s takes about 546 seconds, leaving
// roughly 54 seconds of the ten-minute deadline for requests and redirects.
const ACQUISITION_DEADLINE_MS = 10 * 60 * 1000;
const MAX_REDIRECTS = 5;
const DISK_HEADROOM_FRACTION = 0.1;
const DISK_HEADROOM_FORMULA =
    "totalExpectedArtifactBytes + ceil(totalExpectedArtifactBytes * diskHeadroomFraction)";
const FROZEN_LATEON_D32_PROFILE_SHA256 =
    "04958f55784968a2a45c1499adc2fcb706dcd23e9813c8e8da7e3f31f43777f6";
const DEFAULT_LATEON_REPOSITORY = "lightonai/LateOn-Code-edge";
const DEFAULT_LATEON_REVISION = "07ef20f406c86badca122464808f4cac2f6e4b25";

type LateOnProfileArtifact = Readonly<{
    path: string;
    sha256: string;
}>;

type LateOnRuntimeProfile = Readonly<{
    schemaVersion: "satori_lateon_runtime_profile_v5";
    profileId: string;
    qualificationStatus?: string;
    identity: Readonly<{
        repository: string;
        revision: string;
        license: string;
    }>;
    artifacts: readonly LateOnProfileArtifact[];
    inference?: Readonly<{
        candidateDepth?: number;
    }>;
}>;

type LateOnAcquisitionArtifact = Readonly<{
    path: string;
    sizeBytes: number;
    sha256: string;
}>;

type LateOnAcquisitionManifest = Readonly<{
    schemaVersion: typeof ACQUISITION_SCHEMA_VERSION;
    runtimeProfileSha256: string;
    artifacts: readonly LateOnAcquisitionArtifact[];
    totalExpectedArtifactBytes: number;
    policy: Readonly<{
        downloadDeadlineMilliseconds: number;
        maximumRedirects: number;
        diskHeadroomFraction: number;
        diskHeadroomFormula: string;
    }>;
}>;

export type LateOnAcquisitionAuthority = Readonly<{
    profileId: string;
    repository: string;
    revision: string;
    runtimeProfileSha256: string;
    artifacts: readonly LateOnAcquisitionArtifact[];
    totalExpectedArtifactBytes: number;
    downloadDeadlineMilliseconds: number;
    maximumRedirects: number;
    diskHeadroomFraction: number;
    diskHeadroomFormula: string;
}>;

/**
 * Loads the acquisition authority shipped in an MCP package root.
 * The structural loader does not bind the frozen digest; production entry
 * points use the frozen-binding loader by default. Structural acquisition
 * tests inject this loader through `authorityLoader` to exercise
 * acquisition behavior against synthetic, non-frozen fixtures.
 */
export type LateOnAuthorityLoader = (runtimePackageRoot: string) => LateOnAcquisitionAuthority;

export type VerifiedLateOnModel = Readonly<{
    modelDirectory: string;
    profileId: string;
    runtimeProfileSha256: string;
}>;

export type EnsureLateOnModelInput = Readonly<{
    homeDir: string;
    runtimePackageRoot: string;
    env?: NodeJS.ProcessEnv;
    fetchImpl?: typeof fetch;
    onProgress?: ModelProgressReporter;
    /** Test seam for proving disk failures without depending on the host filesystem. */
    statfsImpl?: (path: string) => { bavail: number; bsize: number };
    /** Test seams for stalled and retried downloads. */
    stallTimeoutMs?: number;
    retryDelaysMs?: readonly number[];
    /** Structural test seam; the production default binds the frozen digest. */
    authorityLoader?: LateOnAuthorityLoader;
    /** Test seam for proving the destination-appears-before-rename race. */
    renameImpl?: (from: string, to: string) => void;
}>;

function sha256Bytes(bytes: Buffer): string {
    return crypto.createHash("sha256").update(bytes).digest("hex");
}

function assertSha256(value: unknown, label: string): asserts value is string {
    if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value)) {
        throw new Error(`LateOn ${label} must be a lowercase SHA-256 digest.`);
    }
}

function assertPositiveSafeInteger(value: unknown, label: string): asserts value is number {
    if (!Number.isSafeInteger(value) || (value as number) <= 0) {
        throw new Error(`LateOn ${label} must be a positive safe integer.`);
    }
}

function readJson(filePath: string): unknown {
    return JSON.parse(fs.readFileSync(filePath, "utf8")) as unknown;
}

/** Structural acquisition loader; does not bind the frozen digest (test seam). */
export function loadAcquisitionAuthority(runtimePackageRoot: string): LateOnAcquisitionAuthority {
    if (!path.isAbsolute(runtimePackageRoot)) {
        throw new Error("LateOn runtime package root must be absolute.");
    }
    const profilePath = path.join(runtimePackageRoot, "assets", "lateon", LATEON_PROFILE_FILE);
    const acquisitionPath = path.join(runtimePackageRoot, "assets", "lateon", LATEON_ACQUISITION_FILE);
    let profileBytes: Buffer;
    let profile: Partial<LateOnRuntimeProfile>;
    let manifest: Partial<LateOnAcquisitionManifest>;
    try {
        profileBytes = fs.readFileSync(profilePath);
        profile = readJson(profilePath) as Partial<LateOnRuntimeProfile>;
        manifest = readJson(acquisitionPath) as Partial<LateOnAcquisitionManifest>;
    } catch {
        throw new Error(
            `The installed MCP package must contain the frozen LateOn D32 profile and acquisition manifest at '${path.dirname(profilePath)}'.`,
        );
    }

    const runtimeProfileSha256 = sha256Bytes(profileBytes);
    if (
        profile.schemaVersion !== "satori_lateon_runtime_profile_v5"
        || typeof profile.profileId !== "string"
        || profile.profileId.length === 0
        || profile.identity?.repository !== DEFAULT_LATEON_REPOSITORY
        || profile.identity.revision !== DEFAULT_LATEON_REVISION
        || profile.identity.license !== "Apache-2.0"
        || profile.inference?.candidateDepth !== 32
        || !Array.isArray(profile.artifacts)
        || profile.artifacts.length === 0
    ) {
        throw new Error("The installed MCP package does not contain the pinned LateOn D32 profile.");
    }
    if (
        manifest.schemaVersion !== ACQUISITION_SCHEMA_VERSION
        || manifest.runtimeProfileSha256 !== runtimeProfileSha256
        || !Array.isArray(manifest.artifacts)
        || !Number.isSafeInteger(manifest.totalExpectedArtifactBytes)
        || !manifest.policy
    ) {
        throw new Error(
            `The installed MCP package contains a missing or mismatched LateOn acquisition manifest for '${profilePath}'.`,
        );
    }
    assertPositiveSafeInteger(manifest.totalExpectedArtifactBytes, "total artifact byte count");

    const profileArtifacts = new Map<string, string>();
    for (const artifact of profile.artifacts) {
        assertSafeModelArtifactPath(artifact?.path, "LateOn acquisition manifest");
        assertSha256(artifact?.sha256, `profile artifact '${artifact.path}'`);
        if (profileArtifacts.has(artifact.path)) {
            throw new Error(`LateOn profile contains duplicate artifact path '${artifact.path}'.`);
        }
        profileArtifacts.set(artifact.path, artifact.sha256);
    }

    const acquisitionArtifacts: LateOnAcquisitionArtifact[] = [];
    const acquisitionPaths = new Set<string>();
    for (const artifact of manifest.artifacts) {
        assertSafeModelArtifactPath(artifact?.path, "LateOn acquisition manifest");
        assertSha256(artifact?.sha256, `acquisition artifact '${artifact.path}'`);
        assertPositiveSafeInteger(artifact?.sizeBytes, `size for '${artifact.path}'`);
        if (acquisitionPaths.has(artifact.path)) {
            throw new Error(`LateOn acquisition manifest contains duplicate artifact path '${artifact.path}'.`);
        }
        if (profileArtifacts.get(artifact.path) !== artifact.sha256) {
            throw new Error(
                `LateOn acquisition manifest does not match profile artifact '${artifact.path}'.`,
            );
        }
        acquisitionPaths.add(artifact.path);
        acquisitionArtifacts.push({
            path: artifact.path,
            sizeBytes: artifact.sizeBytes,
            sha256: artifact.sha256,
        });
    }
    if (acquisitionArtifacts.length !== profileArtifacts.size) {
        throw new Error("LateOn acquisition manifest and runtime profile have different artifact paths.");
    }

    const totalExpectedArtifactBytes = acquisitionArtifacts.reduce(
        (total, artifact) => total + artifact.sizeBytes,
        0,
    );
    if (totalExpectedArtifactBytes !== manifest.totalExpectedArtifactBytes) {
        throw new Error("LateOn acquisition manifest total bytes do not equal its artifact entries.");
    }
    const policy = manifest.policy;
    if (
        policy.downloadDeadlineMilliseconds !== ACQUISITION_DEADLINE_MS
        || policy.maximumRedirects !== MAX_REDIRECTS
        || policy.diskHeadroomFraction !== DISK_HEADROOM_FRACTION
        || policy.diskHeadroomFormula !== DISK_HEADROOM_FORMULA
    ) {
        throw new Error("LateOn acquisition manifest contains an unsupported acquisition policy.");
    }

    return Object.freeze({
        profileId: profile.profileId,
        repository: profile.identity.repository,
        revision: profile.identity.revision,
        runtimeProfileSha256,
        artifacts: Object.freeze(acquisitionArtifacts),
        totalExpectedArtifactBytes,
        downloadDeadlineMilliseconds: policy.downloadDeadlineMilliseconds,
        maximumRedirects: policy.maximumRedirects,
        diskHeadroomFraction: policy.diskHeadroomFraction,
        diskHeadroomFormula: policy.diskHeadroomFormula,
    });
}

export function calculateRequiredLateOnFreeBytes(
    totalExpectedArtifactBytes: number,
    diskHeadroomFraction = DISK_HEADROOM_FRACTION,
): number {
    assertPositiveSafeInteger(totalExpectedArtifactBytes, "total artifact byte count");
    if (!Number.isFinite(diskHeadroomFraction) || diskHeadroomFraction < 0) {
        throw new Error("LateOn disk headroom fraction must be finite and non-negative.");
    }
    const required = totalExpectedArtifactBytes
        + Math.ceil(totalExpectedArtifactBytes * diskHeadroomFraction);
    if (!Number.isSafeInteger(required)) {
        throw new Error("LateOn required free-byte calculation overflowed.");
    }
    return required;
}

function frozenAcquisitionAuthority(runtimePackageRoot: string): LateOnAcquisitionAuthority {
    const authority = loadAcquisitionAuthority(runtimePackageRoot);
    if (authority.runtimeProfileSha256 !== FROZEN_LATEON_D32_PROFILE_SHA256) {
        throw new Error(
            "The shipped LateOn D32 runtime profile is not the frozen profile "
            + `(expected sha256 ${FROZEN_LATEON_D32_PROFILE_SHA256}).`,
        );
    }
    return authority;
}

export function readLateOnAcquisitionAuthority(runtimePackageRoot: string): LateOnAcquisitionAuthority {
    return frozenAcquisitionAuthority(runtimePackageRoot);
}

function lateOnModelSpec(authority: LateOnAcquisitionAuthority): ModelSpec {
    return Object.freeze({
        id: "lateon",
        label: "LateOn reranker model",
        repository: authority.repository,
        revision: authority.revision,
        artifacts: authority.artifacts,
    });
}

export function resolveDefaultLateOnModelDirectory(homeDir: string): string {
    return resolveModelDirectory(homeDir, {
        id: "lateon",
        label: "LateOn reranker model",
        repository: DEFAULT_LATEON_REPOSITORY,
        revision: DEFAULT_LATEON_REVISION,
        artifacts: [],
    });
}

export function verifyLateOnModelDirectory(input: Readonly<{
    modelDirectory: string;
    runtimePackageRoot: string;
    /** Structural test seam; the production default binds the frozen digest. */
    authorityLoader?: LateOnAuthorityLoader;
}>): VerifiedLateOnModel {
    const authority = (input.authorityLoader ?? frozenAcquisitionAuthority)(input.runtimePackageRoot);
    const modelDirectory = path.resolve(input.modelDirectory);
    verifyModelDirectory(modelDirectory, lateOnModelSpec(authority));
    return Object.freeze({
        modelDirectory,
        profileId: authority.profileId,
        runtimeProfileSha256: authority.runtimeProfileSha256,
    });
}

export async function ensureDefaultLateOnModel(
    input: EnsureLateOnModelInput,
): Promise<VerifiedLateOnModel> {
    const authority = (input.authorityLoader ?? frozenAcquisitionAuthority)(input.runtimePackageRoot);
    const { modelDirectory } = await ensureModel({
        homeDir: input.homeDir,
        spec: lateOnModelSpec(authority),
        env: input.env,
        fetchImpl: input.fetchImpl,
        onProgress: input.onProgress,
        statfsImpl: input.statfsImpl,
        stallTimeoutMs: input.stallTimeoutMs,
        retryDelaysMs: input.retryDelaysMs,
        renameImpl: input.renameImpl,
    });
    return Object.freeze({
        modelDirectory,
        profileId: authority.profileId,
        runtimeProfileSha256: authority.runtimeProfileSha256,
    });
}
