/**
 * Lightweight Python relationship-provider identity.
 *
 * This leaf has no imports or side effects so identity aggregates can read the
 * provider-owned facts without loading the resolver implementation.
 */

/** Stable semantic configuration identity; publication generations are not part of it. */
export const PYTHON_NATIVE_ENVIRONMENT_CONFIG_ID = 'python-native-resolution-v2';
export const NATIVE_PYTHON_PROVIDER_ID = 'satori-native-python';
export const NATIVE_PYTHON_PROVIDER_VERSION = 'bounded-origin-v4';
