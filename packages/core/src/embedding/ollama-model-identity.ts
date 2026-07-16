import { Ollama } from 'ollama';

const DEFAULT_OLLAMA_HOST = 'http://127.0.0.1:11434';
const OLLAMA_DIGEST = /^(?:sha256:)?([a-f0-9]{64})$/i;

interface OllamaCatalogModel {
    name: string;
    model: string;
    digest: string;
    size: number;
}

export interface OllamaIdentityClient {
    list(): Promise<{ models: OllamaCatalogModel[] }>;
    embed(request: { model: string; input: string }): Promise<{ embeddings: number[][] }>;
}

export interface ResolvedOllamaModelIdentity {
    configuredModel: string;
    resolvedModel: string;
    artifactDigest: string;
    artifactSize: number;
    dimension: number;
}

function modelAliases(model: string): readonly string[] {
    return model.includes(':') ? [model] : [model, `${model}:latest`];
}

export async function resolveOllamaModelIdentity(input: {
    model: string;
    host?: string;
    client?: OllamaIdentityClient;
}): Promise<Readonly<ResolvedOllamaModelIdentity>> {
    const configuredModel = input.model.trim();
    if (!configuredModel) {
        throw new Error('OLLAMA_MODEL must be a non-empty model name.');
    }

    const client = input.client ?? new Ollama({
        host: input.host || DEFAULT_OLLAMA_HOST,
    }) as OllamaIdentityClient;
    const catalog = await client.list();
    const aliases = modelAliases(configuredModel);
    const matches = catalog.models.filter((entry) => (
        aliases.includes(entry.name) || aliases.includes(entry.model)
    ));
    if (matches.length === 0) {
        throw new Error(
            `Configured Ollama model '${configuredModel}' is not installed.`,
        );
    }

    const distinctDigests = new Set(matches.map((entry) => entry.digest));
    if (matches.length > 1 && distinctDigests.size > 1) {
        throw new Error(
            `Configured Ollama model '${configuredModel}' resolves to multiple local artifacts.`,
        );
    }

    const match = matches[0];
    if (!match) throw new Error(`Configured Ollama model '${configuredModel}' is not installed.`);
    const digestMatch = OLLAMA_DIGEST.exec(match.digest.trim());
    if (!digestMatch?.[1]) {
        throw new Error(
            `Configured Ollama model '${configuredModel}' has no valid local artifact digest.`,
        );
    }

    if (!Number.isSafeInteger(match.size) || match.size < 1) {
        throw new Error(
            `Configured Ollama model '${configuredModel}' has no valid local artifact size.`,
        );
    }

    const probeInputs = [
        'satori embedding identity probe',
        'satori embedding dimension stability probe',
    ] as const;
    const probeVectors = await Promise.all(probeInputs.map(async (probeInput) => {
        const response = await client.embed({
            model: match.model || match.name,
            input: probeInput,
        });
        return response.embeddings[0];
    }));
    const vector = probeVectors[0];
    if (
        !vector
        || vector.length === 0
        || probeVectors.some((probeVector) => (
            !probeVector
            || probeVector.length !== vector.length
            || probeVector.some((value) => !Number.isFinite(value))
        ))
    ) {
        throw new Error(
            `Configured Ollama model '${configuredModel}' returned invalid or dimensionally unstable probe vectors.`,
        );
    }

    return Object.freeze({
        configuredModel,
        resolvedModel: match.model || match.name,
        artifactDigest: digestMatch[1].toLowerCase(),
        artifactSize: match.size,
        dimension: vector.length,
    });
}
