import * as fsp from 'fs/promises';
import * as path from 'path';
import { TextDecoder } from 'util';
import {
    ALL_TEXT_INDEX_MARKER,
    INDEXABLE_EXACT_FILENAMES,
} from './defaults';


const DEFAULT_ALL_TEXT_MAX_BYTES = 1_048_576;
const TEXT_PROBE_BYTES = 8192;
const utf8Decoder = new TextDecoder('utf-8', { fatal: true });

export function normalizeSupportedExtension(extension: string): string {
    const value = extension.trim();
    if (!value) {
        return '';
    }
    if (value === ALL_TEXT_INDEX_MARKER) {
        return ALL_TEXT_INDEX_MARKER;
    }
    return value.startsWith('.') ? value.toLowerCase() : `.${value.toLowerCase()}`;
}

export function normalizeSupportedExtensions(extensions: readonly string[]): string[] {
    return [...new Set(
        extensions
            .map(normalizeSupportedExtension)
            .filter((extension) => extension.length > 0)
    )];
}

function parsePositiveInteger(rawValue: string | undefined, fallback: number): number {
    if (!rawValue) {
        return fallback;
    }
    const parsed = Number.parseInt(rawValue, 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function getAllTextMaxBytes(): number {
    return parsePositiveInteger(process.env.SATORI_ALL_TEXT_MAX_BYTES, DEFAULT_ALL_TEXT_MAX_BYTES);
}

function isAllowedExactFilename(relativePath: string): boolean {
    const basename = path.basename(relativePath).toLowerCase();
    return INDEXABLE_EXACT_FILENAMES.some((filename) => filename.toLowerCase() === basename);
}

async function isUtf8TextObservationUnderLimit(
    size: number,
    readProbe: () => Promise<Buffer>,
): Promise<boolean> {
    if (size > getAllTextMaxBytes()) {
        return false;
    }
    if (size === 0) {
        return true;
    }

    try {
        const view = await readProbe();
        if (view.includes(0)) {
            return false;
        }
        utf8Decoder.decode(view);
        return true;
    } catch {
        return false;
    }
}

export async function isIndexableFileObservationByPolicy(
    relativePath: string,
    size: number,
    supportedExtensions: string[],
    readProbe: () => Promise<Buffer>,
): Promise<boolean> {
    const normalizedExtensions = normalizeSupportedExtensions(supportedExtensions);
    const extensionSet = new Set(normalizedExtensions);
    const extension = path.extname(relativePath).toLowerCase();

    if (extension && extensionSet.has(extension)) {
        return true;
    }
    if (isAllowedExactFilename(relativePath)) {
        return true;
    }
    if (!extensionSet.has(ALL_TEXT_INDEX_MARKER)) {
        return false;
    }

    return isUtf8TextObservationUnderLimit(size, readProbe);
}

export async function isIndexableFileByPolicy(
    relativePath: string,
    absolutePath: string,
    size: number,
    supportedExtensions: string[]
): Promise<boolean> {
    let handle: fsp.FileHandle | undefined;
    try {
        return await isIndexableFileObservationByPolicy(
            relativePath,
            size,
            supportedExtensions,
            async () => {
                handle ??= await fsp.open(absolutePath, 'r');
                const buffer = Buffer.alloc(Math.min(size, TEXT_PROBE_BYTES));
                const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
                return buffer.subarray(0, bytesRead);
            },
        );
    } finally {
        await handle?.close();
    }
}

import { DefaultSemanticLanguageRegistry } from '../semantic/descriptor';

let defaultRegistry: DefaultSemanticLanguageRegistry | null = null;
function getDefaultRegistry(): DefaultSemanticLanguageRegistry {
    if (!defaultRegistry) {
        defaultRegistry = new DefaultSemanticLanguageRegistry();
    }
    return defaultRegistry;
}

export function isSemanticAuxiliaryFilename(relativePath: string): boolean {
    return getDefaultRegistry().isAuxiliaryPath(relativePath);
}

export async function isObservableFileObservationByPolicy(
    relativePath: string,
    size: number,
    supportedExtensions: string[],
    readProbe: () => Promise<Buffer>,
): Promise<boolean> {
    if (isSemanticAuxiliaryFilename(relativePath)) {
        return true;
    }
    return isIndexableFileObservationByPolicy(relativePath, size, supportedExtensions, readProbe);
}

export async function isObservableFileByPolicy(
    relativePath: string,
    absolutePath: string,
    size: number,
    supportedExtensions: string[],
): Promise<boolean> {
    if (isSemanticAuxiliaryFilename(relativePath)) {
        return true;
    }
    return isIndexableFileByPolicy(relativePath, absolutePath, size, supportedExtensions);
}
