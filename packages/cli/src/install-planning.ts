import os from "node:os";
import { CliError } from "./errors.js";
import type {
    InstallCommandInput,
    InstallCommandOptions,
    ManagedRuntimeCommand,
} from "./install-contracts.js";
import {
    plannedManagedRuntimeCommand,
    resolveManagedClientCommand,
} from "./managed-runtime-paths.js";
import { resolveManagedPackageSpecifier } from "./managed-package.js";
import { selectClientTargets } from "./client-targets.js";
import {
    prepareMutation,
    prepareProjectProfileInstall,
    type FileMutation,
    type PreparedMutation,
} from "./client-config-mutations.js";

export type InstallPlanOptions = Readonly<
    Pick<
        InstallCommandOptions,
        'runtimeCommand' | 'execFileSyncImpl' | 'platform' | 'architecture' | 'libc' | 'onRuntimeStep'
    >
>;

export interface InstallPlan {
    readonly command: InstallCommandInput;
    readonly homeDir: string;
    readonly packageSpecifier: string;
    readonly plannedRuntimeCommand: ManagedRuntimeCommand;
    readonly clientCommand: ManagedRuntimeCommand;
    readonly profileMutation: FileMutation & { filePath?: string };
    readonly prepared: readonly PreparedMutation[];
    readonly options: InstallPlanOptions;
}

export function resolveDefaultPackageSpecifier(): string {
    try {
        return resolveManagedPackageSpecifier();
    } catch {
        // Fall through to hard failure below.
    }
    throw new CliError("E_USAGE", "Unable to resolve the installed Satori package version for CLI install.", 2);
}

export function createInstallPlan(
    command: InstallCommandInput,
    options: InstallCommandOptions = {}
): InstallPlan {
    const homeDir = options.homeDir ?? os.homedir();
    const repoDir = options.repoDir ?? process.cwd();
    const packageSpecifier = options.packageSpecifier ?? resolveDefaultPackageSpecifier();
    const plannedRuntimeCommand = options.runtimeCommand ?? plannedManagedRuntimeCommand(homeDir, packageSpecifier);
    const clientCommand = resolveManagedClientCommand(homeDir);
    const profileMutation: FileMutation & { filePath?: string } = command.kind === "install"
        ? prepareProjectProfileInstall(repoDir, command.profile)
        : { changed: false, apply: () => {} };

    const prepared = Object.freeze(
        selectClientTargets(homeDir, command.client, options.env ?? process.env)
            .map((target) => prepareMutation(target, command, clientCommand))
            .map((mutation) => Object.freeze({
                ...mutation,
                configMutation: Object.freeze({ ...mutation.configMutation }),
                companionMutations: Object.freeze(
                    mutation.companionMutations.map((companion) => Object.freeze({ ...companion })),
                ),
            })),
    );

    // Snapshot only the application-relevant option fields so application is
    // bound to the plan that was created, not to the caller's mutable object.
    const planOptions = Object.freeze({
        runtimeCommand: options.runtimeCommand,
        execFileSyncImpl: options.execFileSyncImpl,
        platform: options.platform,
        architecture: options.architecture,
        libc: options.libc,
    });

    return Object.freeze({
        command: Object.freeze({ ...command }),
        homeDir,
        packageSpecifier,
        plannedRuntimeCommand: Object.freeze({
            command: plannedRuntimeCommand.command,
            args: Object.freeze([...plannedRuntimeCommand.args]) as unknown as string[],
        }),
        clientCommand: Object.freeze({
            command: clientCommand.command,
            args: Object.freeze([...clientCommand.args]) as unknown as string[],
        }),
        profileMutation: Object.freeze({ ...profileMutation }),
        prepared,
        options: planOptions,
    });
}