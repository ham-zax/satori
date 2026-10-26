/**
 * Lightweight TypeScript compiler-provider identity.
 *
 * This leaf has no imports or side effects so identity aggregates can read the
 * provider-owned facts without loading the compiler implementation.
 */

export const TYPESCRIPT_COMPILER_PROVIDER_ID = 'satori-typescript-compiler';
export const TYPESCRIPT_COMPILER_PROVIDER_VERSION = 'ts-compiler-v12';
