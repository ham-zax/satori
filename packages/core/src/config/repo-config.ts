import * as fs from 'fs';
import * as path from 'path';
import { IndexProfile, normalizeIndexProfile } from './defaults';

export const SATORI_REPO_CONFIG_FILENAME = 'satori.toml';

export interface SatoriRepoConfig {
    configPath?: string;
    profile: IndexProfile;
}

function stripTomlComment(line: string): string {
    let inString = false;
    let escaped = false;
    for (let index = 0; index < line.length; index += 1) {
        const char = line[index];
        if (escaped) {
            escaped = false;
            continue;
        }
        if (char === '\\' && inString) {
            escaped = true;
            continue;
        }
        if (char === '"') {
            inString = !inString;
            continue;
        }
        if (char === '#' && !inString) {
            return line.slice(0, index);
        }
    }
    return line;
}

function parseTomlScalar(rawValue: string): string {
    const value = stripTomlComment(rawValue).trim();
    if (value.startsWith('"') && value.endsWith('"')) {
        return JSON.parse(value) as string;
    }
    return value;
}

export function parseSatoriRepoConfig(content: string, configPath: string): SatoriRepoConfig {
    let currentTable = '';
    let profile: IndexProfile | null = null;

    for (const rawLine of content.split(/\r?\n/)) {
        const line = stripTomlComment(rawLine).trim();
        if (!line) {
            continue;
        }
        const tableMatch = line.match(/^\[([A-Za-z0-9_.-]+)\]$/);
        if (tableMatch) {
            currentTable = tableMatch[1] || '';
            continue;
        }
        if (currentTable !== 'index') {
            continue;
        }
        const profileMatch = line.match(/^profile\s*=\s*(.+)$/);
        if (!profileMatch) {
            continue;
        }
        profile = normalizeIndexProfile(parseTomlScalar(profileMatch[1] || ''));
        if (!profile) {
            throw new Error(`Invalid ${SATORI_REPO_CONFIG_FILENAME} index.profile in ${configPath}. Expected one of: default, minimal, all-text.`);
        }
    }

    return {
        configPath,
        profile: profile || 'default',
    };
}

export function loadSatoriRepoConfig(codebasePath: string): SatoriRepoConfig {
    const configPath = path.join(codebasePath, SATORI_REPO_CONFIG_FILENAME);
    if (!fs.existsSync(configPath)) {
        return { profile: 'default' };
    }
    const stat = fs.statSync(configPath);
    if (!stat.isFile()) {
        return { profile: 'default' };
    }
    return parseSatoriRepoConfig(fs.readFileSync(configPath, 'utf8'), configPath);
}
