import {
    RawSemanticResult,
    ReceiverBindingKind,
    SemanticDecision,
    SemanticStrategy,
    STRUCT_OFFSETS,
    TargetKind,
} from './wasm-types';
import { loadSemanticEngine, type NativeSemanticEngine } from './wasm-loader';

function allocateBytes(native: NativeSemanticEngine, bytes: Uint8Array): number {
    const ptr = native._malloc(bytes.length + 1);
    if (ptr === 0) {
        throw new Error('Out of memory allocating buffer in WASM runtime');
    }
    native.HEAPU8.set(bytes, ptr);
    native.HEAPU8[ptr + bytes.length] = 0;
    return ptr;
}

function freePtr(native: NativeSemanticEngine, ptr: number): void {
    if (ptr !== 0) {
        native._free(ptr);
    }
}

export class WasmSemanticSession {
    private isDestroyed = false;

    constructor(
        private readonly native: NativeSemanticEngine,
        private readonly handle: number,
    ) {}

    get handleId(): number {
        return this.handle;
    }

    addSource(filePath: string, source: string): void {
        this.assertNotDestroyed();
        const pathBytes = Buffer.from(filePath, 'utf8');
        const srcBytes = Buffer.from(source, 'utf8');

        const pathPtr = allocateBytes(this.native, pathBytes);
        const srcPtr = allocateBytes(this.native, srcBytes);
        try {
            const rc = this.native._satori_semantic_add_source(
                this.handle,
                pathPtr,
                pathBytes.length,
                srcPtr,
                srcBytes.length,
            );
            if (rc !== 0) {
                const errPtr = this.native._satori_semantic_last_error(this.handle);
                const errMsg = this.native.UTF8ToString(errPtr) || `addSource failed with code ${rc}`;
                throw new Error(errMsg);
            }
        } finally {
            freePtr(this.native, pathPtr);
            freePtr(this.native, srcPtr);
        }
    }

    addAuxiliary(role: string, filePath: string, source: string): void {
        this.assertNotDestroyed();
        const roleBytes = Buffer.from(role, 'utf8');
        const pathBytes = Buffer.from(filePath, 'utf8');
        const srcBytes = Buffer.from(source, 'utf8');

        const rolePtr = allocateBytes(this.native, roleBytes);
        const pathPtr = allocateBytes(this.native, pathBytes);
        const srcPtr = allocateBytes(this.native, srcBytes);
        try {
            const rc = this.native._satori_semantic_add_auxiliary(
                this.handle,
                rolePtr,
                roleBytes.length,
                pathPtr,
                pathBytes.length,
                srcPtr,
                srcBytes.length,
            );
            if (rc !== 0) {
                const errPtr = this.native._satori_semantic_last_error(this.handle);
                const errMsg = this.native.UTF8ToString(errPtr) || `addAuxiliary failed with code ${rc}`;
                throw new Error(errMsg);
            }
        } finally {
            freePtr(this.native, rolePtr);
            freePtr(this.native, pathPtr);
            freePtr(this.native, srcPtr);
        }
    }

    async resolve(): Promise<RawSemanticResult[]> {
        this.assertNotDestroyed();
        const rc = await this.native._satori_semantic_resolve(this.handle);
        if (rc !== 0) {
            const errPtr = this.native._satori_semantic_last_error(this.handle);
            const errMsg = this.native.UTF8ToString(errPtr) || `resolve failed with code ${rc}`;
            throw new Error(errMsg);
        }

        const count = this.native._satori_semantic_relationship_count(this.handle);
        if (count === 0) return [];

        const resultsPtr = this.native._satori_semantic_relationships(this.handle);
        const strTablePtr = this.native._satori_semantic_string_table(this.handle, 0);

        const results: RawSemanticResult[] = [];

        for (let i = 0; i < count; i++) {
            const offset = resultsPtr + i * 64;

            const srcFileOff = this.native.getValue(offset + STRUCT_OFFSETS.SOURCE_FILE_OFFSET, 'i32');
            const srcFileLen = this.native.getValue(offset + STRUCT_OFFSETS.SOURCE_FILE_LENGTH, 'i32');
            const callStart = this.native.getValue(offset + STRUCT_OFFSETS.CALL_START_BYTE, 'i32');
            const callEnd = this.native.getValue(offset + STRUCT_OFFSETS.CALL_END_BYTE, 'i32');

            const tgtFileOff = this.native.getValue(offset + STRUCT_OFFSETS.TARGET_FILE_OFFSET, 'i32');
            const tgtFileLen = this.native.getValue(offset + STRUCT_OFFSETS.TARGET_FILE_LENGTH, 'i32');
            const tgtNameOff = this.native.getValue(offset + STRUCT_OFFSETS.TARGET_NAME_OFFSET, 'i32');
            const tgtNameLen = this.native.getValue(offset + STRUCT_OFFSETS.TARGET_NAME_LENGTH, 'i32');
            const tgtStart = this.native.getValue(offset + STRUCT_OFFSETS.TARGET_START_BYTE, 'i32');
            const tgtEnd = this.native.getValue(offset + STRUCT_OFFSETS.TARGET_END_BYTE, 'i32');

            const recvTypeOff = this.native.getValue(offset + STRUCT_OFFSETS.RECEIVER_TYPE_OFFSET, 'i32');
            const recvTypeLen = this.native.getValue(offset + STRUCT_OFFSETS.RECEIVER_TYPE_LENGTH, 'i32');
            const impPathOff = this.native.getValue(offset + STRUCT_OFFSETS.IMPORT_PATH_OFFSET, 'i32');
            const impPathLen = this.native.getValue(offset + STRUCT_OFFSETS.IMPORT_PATH_LENGTH, 'i32');

            const recvBindingKind = this.native.getValue(offset + STRUCT_OFFSETS.RECEIVER_BINDING_KIND, 'i8') as ReceiverBindingKind;
            const targetKind = this.native.getValue(offset + STRUCT_OFFSETS.TARGET_KIND, 'i8') as TargetKind;
            const decision = this.native.getValue(offset + STRUCT_OFFSETS.DECISION, 'i8') as SemanticDecision;
            const strategy = this.native.getValue(offset + STRUCT_OFFSETS.STRATEGY, 'i8') as SemanticStrategy;
            const confidence = this.native.getValue(offset + STRUCT_OFFSETS.CONFIDENCE, 'float');

            const sourceFile = srcFileLen > 0 ? this.native.UTF8ToString(strTablePtr + srcFileOff) : '';
            const targetFile = tgtFileLen > 0 ? this.native.UTF8ToString(strTablePtr + tgtFileOff) : undefined;
            const targetName = tgtNameLen > 0 ? this.native.UTF8ToString(strTablePtr + tgtNameOff) : undefined;
            const receiverType = recvTypeLen > 0 ? this.native.UTF8ToString(strTablePtr + recvTypeOff) : undefined;
            const importPath = impPathLen > 0 ? this.native.UTF8ToString(strTablePtr + impPathOff) : undefined;

            results.push({
                sourceFile,
                callStartByte: callStart,
                callEndByte: callEnd,
                targetFile,
                targetName,
                targetStartByte: tgtEnd > tgtStart ? tgtStart : undefined,
                targetEndByte: tgtEnd > tgtStart ? tgtEnd : undefined,
                receiverType,
                importPath,
                receiverBindingKind: recvBindingKind,
                targetKind,
                decision,
                strategy,
                confidence,
            });
        }

        return results;
    }

    destroy(): void {
        if (!this.isDestroyed) {
            this.native._satori_semantic_free(this.handle);
            this.isDestroyed = true;
        }
    }

    private assertNotDestroyed(): void {
        if (this.isDestroyed) {
            throw new Error(`Semantic session ${this.handle} is already destroyed`);
        }
    }
}

export class WasmSemanticEngine {
    constructor(private readonly native: NativeSemanticEngine) {}

    static async create(): Promise<WasmSemanticEngine> {
        const native = await loadSemanticEngine();
        return new WasmSemanticEngine(native);
    }

    async createSession(language: string): Promise<WasmSemanticSession> {
        const langBytes = Buffer.from(language, 'utf8');
        const langPtr = allocateBytes(this.native, langBytes);
        const outHandlePtr = this.native._malloc(4);
        if (outHandlePtr === 0) {
            freePtr(this.native, langPtr);
            throw new Error('Out of memory allocating handle pointer in WASM');
        }

        try {
            const rc = this.native._satori_semantic_create(langPtr, langBytes.length, outHandlePtr);
            if (rc !== 0) {
                const errPtr = this.native._satori_semantic_global_last_error_message();
                const errMsg = this.native.UTF8ToString(errPtr) || `createSession failed with code ${rc}`;
                throw new Error(errMsg);
            }

            const handle = this.native.getValue(outHandlePtr, 'i32');
            return new WasmSemanticSession(this.native, handle);
        } finally {
            freePtr(this.native, langPtr);
            freePtr(this.native, outHandlePtr);
        }
    }
}
