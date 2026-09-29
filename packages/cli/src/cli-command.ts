export const SATORI_CLI_NPX_COMMAND = "npx -y @satori-code/cli@latest";

export function satoriCliCommand(args: string): string {
    const suffix = args.trim();
    return suffix ? `${SATORI_CLI_NPX_COMMAND} ${suffix}` : SATORI_CLI_NPX_COMMAND;
}
