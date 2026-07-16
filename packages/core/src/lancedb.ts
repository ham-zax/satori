// Keep the native LanceDB dependency behind an explicit lazy-load boundary.
// Importing the general Core API must remain safe on platforms that use Milvus.
export { LanceDbVectorDatabase } from './vectordb/lancedb-vectordb';
export type { LanceDbConfig } from './vectordb/lancedb-vectordb';
