declare module 'node:sqlite' {
    export interface DatabaseSyncOptions {
        open?: boolean;
        readOnly?: boolean;
        enableForeignKeyConstraints?: boolean;
    }

    export interface StatementSync {
        all(...params: unknown[]): Record<string, unknown>[];
        get(...params: unknown[]): Record<string, unknown> | undefined;
        run(...params: unknown[]): unknown;
    }

    export class DatabaseSync {
        constructor(path: string, options?: DatabaseSyncOptions);
        exec(sql: string): void;
        prepare(sql: string): StatementSync;
        close(): void;
    }
}
