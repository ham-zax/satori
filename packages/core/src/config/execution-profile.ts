export type ExecutionProfile = 'connected' | 'offline';

export type NetworkPolicy =
    | Readonly<{ kind: 'remote-allowed' }>
    | Readonly<{ kind: 'local-only' }>;

export interface ResolvedExecutionPolicy {
    executionProfile: ExecutionProfile;
    networkPolicy: NetworkPolicy;
}

const CONNECTED_POLICY: ResolvedExecutionPolicy = Object.freeze({
    executionProfile: 'connected',
    networkPolicy: Object.freeze({ kind: 'remote-allowed' as const }),
});

const OFFLINE_POLICY: ResolvedExecutionPolicy = Object.freeze({
    executionProfile: 'offline',
    networkPolicy: Object.freeze({ kind: 'local-only' as const }),
});

/**
 * Resolve the one persisted execution profile into its derived network policy.
 * Missing configuration remains connected for compatibility and must never
 * silently acquire the stronger offline guarantee.
 */
export function resolveExecutionPolicy(value: string | undefined): ResolvedExecutionPolicy {
    if (value === undefined || value === 'connected') return CONNECTED_POLICY;
    if (value === 'offline') return OFFLINE_POLICY;

    throw new Error(
        `Invalid SATORI_RUNTIME_PROFILE '${value}'. Expected connected or offline.`,
    );
}

export function assertNetworkPolicyAllowsEndpoint(
    policy: NetworkPolicy,
    endpoint: string,
    label: string,
): void {
    if (policy.kind === 'remote-allowed') return;

    let url: URL;
    try {
        url = new URL(endpoint);
    } catch {
        throw new Error(`${label} must be an absolute HTTP(S) URL in local-only mode.`);
    }

    const hostname = url.hostname.toLowerCase().replace(/^\[|\]$/g, '');
    const isLoopback = hostname === 'localhost'
        || hostname === '::1'
        || /^127(?:\.\d{1,3}){3}$/.test(hostname);
    if (!['http:', 'https:'].includes(url.protocol) || !isLoopback) {
        throw new Error(
            `${label} must use a loopback HTTP(S) endpoint in local-only mode.`,
        );
    }
}
