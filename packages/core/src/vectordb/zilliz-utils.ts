import { envManager } from '../utils/env-manager';
import { fetchWithDeadline } from '../net/fetch-with-deadline';

type JsonRecord = Record<string, unknown>;

/**
 * Per-request HTTP policy applied to every Zilliz management API call.
 * Reads use the bounded retry policy; creation calls pass `maxAttempts: 1`
 * because a duplicated create request is not idempotent.
 */
export interface ZillizHttpPolicy {
    attemptTimeoutMs: number;
    maxAttempts: number;
    retryDelayMs: number;
    maxResponseBytes: number;
    retryableStatuses: ReadonlySet<number>;
    retryableNetworkCodes: ReadonlySet<string>;
}

export const ZILLIZ_DEFAULT_HTTP_POLICY: ZillizHttpPolicy = {
    attemptTimeoutMs: 30_000,
    maxAttempts: 2,
    retryDelayMs: 250,
    maxResponseBytes: 8 * 1024 * 1024,
    retryableStatuses: new Set([
        408,
        425,
        429,
        ...Array.from({ length: 100 }, (_, index) => 500 + index),
    ]),
    retryableNetworkCodes: new Set(['ETIMEDOUT', 'ECONNRESET', 'EAI_AGAIN']),
};

export interface ZillizConfig {
    baseUrl?: string;
    token?: string;
    /** Per-request HTTP policy override; unspecified fields keep the default policy. */
    httpPolicy?: Partial<ZillizHttpPolicy>;
}

export interface Project {
    projectId: string;
    projectName: string;
    instanceCount: number;
    createTime: string;
}

export interface Cluster {
    clusterId: string;
    clusterName: string;
    description: string;
    regionId: string;
    plan: string;
    cuType: string;
    cuSize: number;
    status: string;
    connectAddress: string;
    privateLinkAddress: string;
    projectId: string;
    createTime: string;
}

export interface CreateFreeClusterRequest {
    clusterName: string;
    projectId: string;
    regionId: string;
}

export interface CreateFreeClusterResponse {
    clusterId: string;
    username: string;
    password: string;
    prompt: string;
}

export interface CreateFreeClusterWithDetailsResponse extends CreateFreeClusterResponse {
    clusterDetails: DescribeClusterResponse;
}

export interface ListProjectsResponse {
    code: number;
    data: Project[];
}

export interface ListClustersResponse {
    code: number;
    data: {
        count: number;
        currentPage: number;
        pageSize: number;
        clusters: Cluster[];
    };
}

export interface CreateFreeClusterApiResponse {
    code: number;
    data: CreateFreeClusterResponse;
}

export interface DescribeClusterResponse {
    clusterId: string;
    clusterName: string;
    projectId: string;
    description: string;
    regionId: string;
    cuType: string;
    plan: string;
    status: string;
    connectAddress: string;
    privateLinkAddress: string;
    createTime: string;
    cuSize: number;
    storageSize: number;
    snapshotNumber: number;
    createProgress: number;
}

export interface DescribeClusterApiResponse {
    code: number;
    data: DescribeClusterResponse;
}

export interface ErrorResponse {
    code: number;
    message: string;
}

function isRecord(value: unknown): value is JsonRecord {
    return typeof value === 'object' && value !== null;
}

function errorMessage(error: unknown): string {
    if (typeof error === 'string') {
        return error;
    }

    if (error instanceof Error) {
        return error.message;
    }

    if (isRecord(error) && typeof error.message === 'string') {
        return error.message;
    }

    return String(error);
}

/**
 * Zilliz Cloud cluster manager
 * For managing Zilliz Cloud projects and clusters
 * See https://docs.zilliz.com/reference/restful/list-clusters-v2 for more details
 */
export class ClusterManager {
    private baseUrl: string;
    private token: string;
    private httpPolicy: ZillizHttpPolicy;

    constructor(config?: ZillizConfig) {
        // Get from environment variables first, otherwise use passed configuration
        this.baseUrl = envManager.get('ZILLIZ_BASE_URL') || config?.baseUrl || 'https://api.cloud.zilliz.com';
        this.token = envManager.get('MILVUS_TOKEN') || config?.token || '';
        this.httpPolicy = { ...ZILLIZ_DEFAULT_HTTP_POLICY, ...config?.httpPolicy };

        if (!this.token) {
            throw new Error('Zilliz API token is required. Please provide it via MILVUS_TOKEN environment variable or config parameter.');
        }
    }

    /**
     * Generic method for sending HTTP requests through the bounded request
     * utility: every attempt has a deadline, retries are bounded and
     * classified, caller cancellation is never retried, and response bodies
     * are byte-limited during consumption.
     */
    private async makeRequest<T>(
        endpoint: string,
        method: 'GET' | 'POST' = 'GET',
        data?: unknown,
        options?: { signal?: AbortSignal; maxAttempts?: number },
    ): Promise<T> {
        const url = `${this.baseUrl}${endpoint}`;

        const headers: Record<string, string> = {
            'Authorization': `Bearer ${this.token}`,
            'Accept': 'application/json',
            'Content-Type': 'application/json',
        };

        const init: RequestInit = {
            method,
            headers,
        };

        if (data && method === 'POST') {
            init.body = JSON.stringify(data);
        }

        try {
            const response = await fetchWithDeadline({
                url,
                init,
                signal: options?.signal,
                attemptTimeoutMs: this.httpPolicy.attemptTimeoutMs,
                maxAttempts: options?.maxAttempts ?? this.httpPolicy.maxAttempts,
                retryDelayMs: this.httpPolicy.retryDelayMs,
                maxResponseBytes: this.httpPolicy.maxResponseBytes,
                retryableStatuses: this.httpPolicy.retryableStatuses,
                retryableNetworkCodes: this.httpPolicy.retryableNetworkCodes,
            });

            if (!response.ok) {
                const errorText = await response.text();
                let errorMessage: string;

                try {
                    const errorJson: unknown = JSON.parse(errorText);
                    errorMessage = isRecord(errorJson) && typeof errorJson.message === 'string'
                        ? errorJson.message
                        : `HTTP ${response.status}: ${response.statusText}`;
                } catch {
                    errorMessage = `HTTP ${response.status}: ${response.statusText}`;
                }

                throw new Error(errorMessage);
            }

            const result = await response.json();
            return result as T;
        } catch (error: unknown) {
            // Caller cancellation propagates unchanged and is never retried.
            if (options?.signal?.aborted) {
                throw options.signal.reason ?? error;
            }
            // Log the original error for more details, especially for fetch errors.
            // BoundedHttpError messages (kind/status/attempts) carry no token.
            console.error('[ZillizUtils] ❌ Original error in makeRequest:', error);
            throw new Error(`Zilliz API request failed: ${errorMessage(error)}`, { cause: error });
        }
    }

    /**
     * Delay that aborts immediately when the caller's signal fires.
     */
    private async abortableDelay(ms: number, signal?: AbortSignal): Promise<void> {
        if (signal?.aborted) {
            throw signal.reason ?? new DOMException('The operation was aborted', 'AbortError');
        }
        await new Promise<void>((resolve, reject) => {
            const onAbort = () => {
                clearTimeout(timer);
                reject(signal?.reason ?? new DOMException('The operation was aborted', 'AbortError'));
            };
            const timer = setTimeout(() => {
                // The delay completed normally: drop the abort listener so a
                // long-lived caller signal does not accumulate one closure per
                // poll cycle. `{ once: true }` alone only removes it on abort.
                signal?.removeEventListener('abort', onAbort);
                resolve();
            }, ms);
            signal?.addEventListener('abort', onAbort, { once: true });
        });
    }

    /**
     * List all projects
     * @returns List of projects
     */
    async listProjects(): Promise<Project[]> {
        const response = await this.makeRequest<ListProjectsResponse>('/v2/projects');

        if (response.code !== 0) {
            throw new Error(`Failed to list projects: ${JSON.stringify(response)}`);
        }

        return response.data;
    }

    /**
     * List all clusters
     * @param projectId Optional project ID filter
     * @param pageSize Page size, default 10
     * @param currentPage Current page number, default 1
     * @returns Cluster list with pagination info
     */
    async listClusters(projectId?: string, pageSize: number = 10, currentPage: number = 1): Promise<{
        clusters: Cluster[];
        count: number;
        currentPage: number;
        pageSize: number;
    }> {
        let endpoint = `/v2/clusters?pageSize=${pageSize}&currentPage=${currentPage}`;
        if (projectId) {
            endpoint += `&projectId=${projectId}`;
        }

        const response = await this.makeRequest<ListClustersResponse>(endpoint);

        if (response.code !== 0) {
            throw new Error(`Failed to list clusters: ${JSON.stringify(response)}`);
        }

        return response.data;
    }

    /**
 * Describe cluster details
 * @param clusterId Cluster ID to describe
 * @returns Cluster details
 */
    async describeCluster(clusterId: string, signal?: AbortSignal): Promise<DescribeClusterResponse> {
        const response = await this.makeRequest<DescribeClusterApiResponse>(
            `/v2/clusters/${clusterId}`,
            'GET',
            undefined,
            { signal },
        );

        if (response.code !== 0) {
            throw new Error(`Failed to describe cluster: ${JSON.stringify(response)}`);
        }

        return response.data;
    }

    /**
 * Create free cluster and wait for it to be ready
 * @param request Request parameters for creating cluster
 * @param timeoutMs Timeout in milliseconds, default 5 minutes
 * @param pollIntervalMs Polling interval in milliseconds, default 5 seconds
 * @returns Creation result including cluster ID, username, password and cluster details
 */
    async createFreeCluster(
        request: CreateFreeClusterRequest,
        timeoutMs: number = 5 * 60 * 1000, // 5 minutes default
        pollIntervalMs: number = 5 * 1000, // 5 seconds default
        signal?: AbortSignal
    ): Promise<CreateFreeClusterWithDetailsResponse> {
        // Create the cluster. Creation is not retried: a duplicated create
        // request is not idempotent, so an ambiguous failure surfaces instead.
        const response = await this.makeRequest<CreateFreeClusterApiResponse>(
            '/v2/clusters/createFree',
            'POST',
            request,
            { signal, maxAttempts: 1 },
        );

        if (response.code !== 0) {
            throw new Error(`Failed to create free cluster: ${JSON.stringify(response)}`);
        }

        const { clusterId } = response.data;
        const startTime = Date.now();

        // Poll cluster status until it's ready, the caller cancels, or the outer
        // deadline expires. Each describe call carries its own bounded deadline,
        // so one call cannot consume the whole outer timeout.
        while (Date.now() - startTime < timeoutMs) {
            if (signal?.aborted) {
                throw signal.reason ?? new DOMException('The operation was aborted', 'AbortError');
            }
            try {
                const clusterInfo = await this.describeCluster(clusterId, signal);

                if (clusterInfo.status === 'RUNNING') {
                    // Cluster is ready, return creation data with cluster details
                    return {
                        ...response.data,
                        clusterDetails: clusterInfo
                    };
                } else if (clusterInfo.status === 'DELETED' || clusterInfo.status === 'ABNORMAL') {
                    // Cluster creation failed
                    throw new Error(`Cluster creation failed with status: ${clusterInfo.status}`);
                }

                // Wait before next poll
                await this.abortableDelay(pollIntervalMs, signal);
            } catch (error: unknown) {
                if (signal?.aborted) {
                    throw signal.reason ?? error;
                }
                // If it's a describe cluster error, continue polling
                // The cluster might not be immediately available for describe
                if (errorMessage(error).includes('Failed to describe cluster')) {
                    await this.abortableDelay(pollIntervalMs, signal);
                    continue;
                }
                throw error;
            }
        }

        // Timeout reached
        throw new Error(`Timeout waiting for cluster ${clusterId} to be ready after ${timeoutMs}ms`);
    }

    /**
     * Static utility method to get address from token using Zilliz Cloud API
     * This method will find or create a cluster and return its connect address
     * @param token Zilliz Cloud API token
     * @returns Connect address for the cluster
     */
    static async getAddressFromToken(token?: string): Promise<string> {
        if (!token) {
            throw new Error('Token is required when address is not provided');
        }

        try {
            const clusterManager = new ClusterManager({ token });

            // Get Default Project ID
            const projects = await clusterManager.listProjects();
            const defaultProject = projects.find(p => p.projectName === 'Default Project');

            if (!defaultProject) {
                throw new Error('Default Project not found');
            }

            // List clusters in the default project
            const clustersResponse = await clusterManager.listClusters(defaultProject.projectId);

            if (clustersResponse.clusters.length > 0) {
                // Use the first available cluster
                const cluster = clustersResponse.clusters[0];
                console.log(`🎯 Using existing cluster: ${cluster.clusterName} (${cluster.clusterId})`);
                return cluster.connectAddress;
            } else {
                // No clusters found, create a free cluster
                console.log('📝 No clusters found, creating a new free cluster...');
                const createResponse = await clusterManager.createFreeCluster({
                    clusterName: `auto-cluster-${Date.now()}`,
                    projectId: defaultProject.projectId,
                    regionId: 'gcp-us-west1' // Default region
                });

                console.log(`[ZillizUtils] ✅ Created new cluster: ${createResponse.clusterId}`);
                return createResponse.clusterDetails.connectAddress;
            }
        } catch (error: unknown) {
            throw new Error(`Failed to get address from token: ${errorMessage(error)}`, { cause: error });
        }
    }
}
