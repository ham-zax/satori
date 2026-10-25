/**
 * Authoritative runtime identity declarations shared by the core package and
 * the standalone CLI. This leaf is pure constants: it has no imports or side
 * effects so the installer can read identity before managed core is installed.
 */

export const EMBEDDING_PROJECTION_VERSION = 'embedding_projection_v3' as const;
export const LEXICAL_PROJECTION_VERSION = 'lexical_projection_v2' as const;
export const POTION_MODEL_ID =
    'minishlab/potion-code-16M-v2@e9d2a44ca6a05ac6685f3b23709ea57eb7352d5b';
export const POTION_DIMENSION = 256;
