import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import readline from "node:readline";
import { Writable } from "node:stream";
import { CliError } from "./errors.js";
import { RERANKER_PROVIDERS } from "./reranker-providers.js";

export interface VoyageKeyInteraction {
    isInteractive?: boolean;
    promptApiKey?: () => Promise<string>;
    writeMessage?: (message: string) => void;
}

/** Readline owns raw mode and restores it on Enter, EOF, or Ctrl+C; its output never echoes input. */
export function promptHiddenApiKey(input: NodeJS.ReadableStream = process.stdin): Promise<string> {
    return new Promise((resolve) => {
        const mutedOutput = new Writable({ write: (_chunk, _encoding, callback) => callback() });
        const rl = readline.createInterface({ input, output: mutedOutput, terminal: true, historySize: 0 });
        let answer = "";
        rl.once("line", (value) => { answer = value; rl.close(); });
        rl.once("SIGINT", () => rl.close());
        rl.once("close", () => { mutedOutput.end(); resolve(answer); });
    });
}

function readEnvFile(envPath: string): string {
    try {
        return fs.readFileSync(envPath, "utf8");
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return "";
        throw new CliError("E_USAGE", `Cannot read ${envPath}; check its permissions before switching to Voyage.`, 2);
    }
}

/** CLI persistence follows core EnvManager's plain KEY=value format without a runtime core dependency. */
export async function resolveVoyageApiKey(
    homeDir: string,
    env: NodeJS.ProcessEnv,
    interaction: VoyageKeyInteraction,
): Promise<string | null> {
    const keyEnv = RERANKER_PROVIDERS.voyage.keyEnv;
    const processKey = env[keyEnv]?.trim();
    if (processKey) return processKey;
    const envPath = path.join(homeDir, ".satori", ".env");
    const entry = readEnvFile(envPath).split("\n").find((line) => line.trim().startsWith(`${keyEnv}=`));
    const fileKey = entry?.trim().slice(keyEnv.length + 1).trim();
    if (fileKey) return fileKey;
    if (!(interaction.isInteractive ?? (process.stdin.isTTY && process.stdout.isTTY))) {
        throw new CliError(
            "E_USAGE",
            `Voyage reranking requires ${keyEnv} in the environment or ${envPath}. Set it there, or run this command in a terminal to enter it securely.`,
            2,
        );
    }

    const writeMessage = interaction.writeMessage ?? ((message: string) => { process.stderr.write(message); });
    writeMessage("Voyage API key (hidden; Enter to cancel): ");
    const apiKey = (await (interaction.promptApiKey ?? promptHiddenApiKey)()).trim();
    writeMessage("\n");
    if (!apiKey) return null;
    if (/[\r\n\0]/.test(apiKey)) {
        throw new CliError("E_USAGE", "The Voyage API key must be a single line without null characters.", 2);
    }

    // Re-read after prompting to preserve any other settings saved while waiting for input.
    let content = readEnvFile(envPath);
    let found = false;
    content = content.split("\n").map((line) => {
        if (!line.trim().startsWith(`${keyEnv}=`)) return line;
        found = true;
        return `${keyEnv}=${apiKey}`;
    }).join("\n");
    if (!found) content += `${content && !content.endsWith("\n") ? "\n" : ""}${keyEnv}=${apiKey}\n`;
    fs.mkdirSync(path.dirname(envPath), { recursive: true, mode: 0o700 });
    const temporaryPath = `${envPath}.${randomUUID()}.tmp`;
    try {
        fs.writeFileSync(temporaryPath, content, { encoding: "utf8", mode: 0o600, flag: "wx" });
        fs.chmodSync(temporaryPath, 0o600);
        fs.renameSync(temporaryPath, envPath);
    } finally {
        fs.rmSync(temporaryPath, { force: true });
    }
    writeMessage(`Saved ${keyEnv} to ${envPath}.\n`);
    return apiKey;
}
