import type {
    CollectionCreateOptions,
    DenseCandidateRequest,
    IndexedVectorDocument,
    LexicalCandidateRequest,
    VectorCandidate,
    VectorControlRecord,
    VectorDatabase,
    VectorDocumentQuery,
    VectorFilter,
    VectorRecord,
} from './types';

/** Strict base for tests that exercise only a bounded subset of the vector port. */
export abstract class VectorDatabaseTestAdapter implements VectorDatabase {
    protected unsupported(operation: string): never {
        throw new Error(`${operation} not implemented by ${this.constructor.name}`);
    }

    async createCollection(_name: string, _dimension: number, _description?: string): Promise<void> {
        this.unsupported('createCollection');
    }

    async createHybridCollection(
        _name: string,
        _dimension: number,
        _description?: string,
        _options?: CollectionCreateOptions,
    ): Promise<void> {
        this.unsupported('createHybridCollection');
    }

    async dropCollection(_name: string): Promise<void> {
        this.unsupported('dropCollection');
    }

    async hasCollection(_name: string): Promise<boolean> {
        return this.unsupported('hasCollection');
    }

    async listCollections(): Promise<string[]> {
        return this.unsupported('listCollections');
    }

    async writeDocuments(_name: string, _documents: IndexedVectorDocument[]): Promise<void> {
        this.unsupported('writeDocuments');
    }

    async insertControl(_name: string, _record: VectorControlRecord): Promise<void> {
        this.unsupported('insertControl');
    }

    async getControl(_name: string, _id: string): Promise<VectorControlRecord | null> {
        return this.unsupported('getControl');
    }

    async deleteControl(_name: string, _id: string): Promise<void> {
        this.unsupported('deleteControl');
    }

    async retrieveDense(_name: string, _request: DenseCandidateRequest): Promise<VectorCandidate[]> {
        return this.unsupported('retrieveDense');
    }

    async retrieveLexical(_name: string, _request: LexicalCandidateRequest): Promise<VectorCandidate[]> {
        return this.unsupported('retrieveLexical');
    }

    async deleteDocuments(_name: string, _ids: string[]): Promise<void> {
        this.unsupported('deleteDocuments');
    }

    async queryDocuments(_name: string, _request: VectorDocumentQuery): Promise<VectorRecord[]> {
        return this.unsupported('queryDocuments');
    }

    async countDocuments(_name: string, _filter?: VectorFilter): Promise<number> {
        return this.unsupported('countDocuments');
    }

    async checkCollectionLimit(): Promise<boolean> {
        return this.unsupported('checkCollectionLimit');
    }
}
