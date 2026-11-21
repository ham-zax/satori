import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { randomUUID } from 'node:crypto';

const VALID_ENV_KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

function assertNotSymlinkRegularFile(filePath: string): fs.Stats | null {
    const stat = fs.lstatSync(filePath, { throwIfNoEntry: false });
    if (!stat) return null;
    if (stat.isSymbolicLink()) {
        throw new Error(`Environment file '${filePath}' must not be a symbolic link.`);
    }
    if (!stat.isFile()) {
        throw new Error(`Environment file '${filePath}' must be a regular file.`);
    }
    return stat;
}

function readEnvFileNoFollow(filePath: string): string | null {
    const stat = assertNotSymlinkRegularFile(filePath);
    if (!stat) return null;
    const flags = fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0);
    const fd = fs.openSync(filePath, flags);
    try {
        return fs.readFileSync(fd, 'utf-8');
    } finally {
        fs.closeSync(fd);
    }
}

export class EnvManager {
    private get envFilePath(): string {
        return path.join(os.homedir(), '.satori', '.env');
    }

    /**
     * Get environment variable by name
     * Priority: process.env > .env file > undefined
     */
    get(name: string): string | undefined {
        // First try to get from process environment variables
        if (process.env[name]) {
            return process.env[name];
        }

        // If not found in process env, try to read from .env file (refusing symlinks)
        try {
            const content = readEnvFileNoFollow(this.envFilePath);
            if (content !== null) {
                const lines = content.split(/\r?\n/);

                for (const line of lines) {
                    const trimmedLine = line.trim();
                    if (trimmedLine.startsWith(`${name}=`)) {
                        return trimmedLine.substring(name.length + 1);
                    }
                }
            }
        } catch {
            // Ignore file read errors or symlink refusals
        }

        return undefined;
    }

    /**
     * Set environment variable to the .env file
     */
    set(name: string, value: string): void {
        if (!VALID_ENV_KEY_RE.test(name)) {
            throw new Error(`Invalid environment variable name '${name}'.`);
        }
        if (/[\r\n\0]/.test(value)) {
            throw new Error(`Environment variable '${name}' must be a single line without newline or null control characters.`);
        }
        try {
            // Ensure directory exists
            const envDir = path.dirname(this.envFilePath);
            if (!fs.existsSync(envDir)) {
                fs.mkdirSync(envDir, { recursive: true, mode: 0o700 });
            }

            let content = '';
            let found = false;

            // Read existing content if file exists (reject symlinks fail-closed)
            const existing = readEnvFileNoFollow(this.envFilePath);
            if (existing !== null) {
                content = existing;

                // Update existing variable
                const lines = content.split(/\r?\n/);
                for (let i = 0; i < lines.length; i++) {
                    if (lines[i].trim().startsWith(`${name}=`)) {
                        // Replace the existing value
                        lines[i] = `${name}=${value}`;
                        found = true;
                        console.log(`[EnvManager] ✅ Updated ${name} in ${this.envFilePath}`);
                        break;
                    }
                }
                content = lines.join('\n');
            }

            // If variable not found, append it
            if (!found) {
                if (content && !content.endsWith('\n')) {
                    content += '\n';
                }
                content += `${name}=${value}\n`;
                console.log(`[EnvManager] ✅ Added ${name} to ${this.envFilePath}`);
            }

            const temporaryPath = `${this.envFilePath}.${randomUUID()}.tmp`;
            try {
                fs.writeFileSync(temporaryPath, content, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
                fs.chmodSync(temporaryPath, 0o600);
                assertNotSymlinkRegularFile(this.envFilePath);
                fs.renameSync(temporaryPath, this.envFilePath);
            } finally {
                fs.rmSync(temporaryPath, { force: true });
            }

        } catch (error) {
            console.error(`[EnvManager] ❌ Failed to write env file: ${error}`);
            throw error;
        }
    }

    /**
     * Get the path to the .env file
     */
    getEnvFilePath(): string {
        return this.envFilePath;
    }
}

// Export a default instance for convenience
export const envManager = new EnvManager();
