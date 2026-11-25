// Publication-local JSON navigation boundary.
//
// PublicationStore owns placement and current selection. This facade exposes
// the JSON artifact writers/readers plus candidate staging inside one explicit
// Publication navigation directory; it owns no selector or retention policy.

export {
    writeRelationshipSidecar,
    writeSymbolRegistrySidecar,
} from './sidecar-writes';
export type {
    WriteRelationshipSidecarInput,
    WriteRelationshipSidecarResult,
    WriteSymbolRegistrySidecarInput,
    WriteSymbolRegistrySidecarResult,
} from './sidecar-writes';
export type {
    StagedPublicationNavigation,
} from './sidecar-lifecycle';
export {
    isRelationshipRecord,
    isSymbolRecord,
} from './sidecar-validators';
export {
    readRelationshipAnalysisEvidence,
    readRelationshipManifestSidecar,
    readRelationshipSidecar,
    readSymbolRegistrySidecar,
    verifyRelationshipSidecarChecksums,
} from './sidecar-reads';
export type {
    PublicationNavigation,
    ReadRelationshipAnalysisEvidenceInput,
    ReadRelationshipAnalysisEvidenceResult,
    ReadRelationshipManifestSidecarResult,
    ReadRelationshipSidecarInput,
    ReadRelationshipSidecarResult,
    ReadSymbolRegistrySidecarInput,
    ReadSymbolRegistrySidecarResult,
    VerifyRelationshipSidecarChecksumsInput,
    VerifyRelationshipSidecarChecksumsResult,
} from './sidecar-reads';
