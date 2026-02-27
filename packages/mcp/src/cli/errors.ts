export class CliError extends Error {
    public readonly token: string;
    public readonly exitCode: number;

    constructor(token: string, message: string, exitCode: number) {
        super(message);
        this.name = "CliError";
        this.token = token;
        this.exitCode = exitCode;
    }
}

export function asCliError(error: unknown): CliError {
    if (error instanceof CliError) {
        return error;
    }
    if (error instanceof Error) {
        return new CliError("E_PROTOCOL_FAILURE", error.message, 3);
    }
    return new CliError("E_PROTOCOL_FAILURE", String(error), 3);
}

