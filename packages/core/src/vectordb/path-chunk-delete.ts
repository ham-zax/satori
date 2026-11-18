import type { VectorDatabase, VectorFilter } from './types';

// LanceDB commits one delete version per deleteDocuments call, so a per-file
// loop turns a large delta into hundreds of versions. Batch paths into one
// query and one delete, but keep the batch small: the backend plans every
// filter literal in the generated SQL, so a huge `relativePath IN (...)`
// costs more to plan than the delete itself.
export const DELETED_PATH_BATCH_SIZE = 200;

// The same literal-planning cost applies to the `id IN (...)` delete filter,
// and bounding each query page keeps Milvus below its maxQueryResultWindow.
export const DELETED_ID_BATCH_SIZE = 500;

export interface DeleteIndexedChunksOptions {
    assertMutationCurrent?: () => void;
    onBatchDeleted?: (deletedChunkCount: number, pathBatchCount: number) => void;
}

/**
 * Delete indexed chunks for a list of repository-relative paths in bounded
 * path batches and bounded ID pages so neither LanceDB SQL planning nor Milvus
 * `maxQueryResultWindow` limits are exceeded.
 */
export async function deleteIndexedChunksForRelativePaths(
    vectorDatabase: Pick<VectorDatabase, 'queryDocuments' | 'deleteDocuments'>,
    collectionName: string,
    relativePaths: readonly string[],
    options?: DeleteIndexedChunksOptions,
): Promise<number> {
    let totalDeleted = 0;

    for (let offset = 0; offset < relativePaths.length; offset += DELETED_PATH_BATCH_SIZE) {
        const batch = relativePaths.slice(offset, offset + DELETED_PATH_BATCH_SIZE);
        const filter: VectorFilter = batch.length === 1
            ? { kind: 'comparison', field: 'relativePath', operator: 'eq', value: batch[0]! }
            : { kind: 'in', field: 'relativePath', values: [...batch] };

        let batchDeleted = 0;
        let previousPageIds: Set<string> | null = null;
        while (true) {
            const results = await vectorDatabase.queryDocuments(collectionName, {
                filter,
                fields: ['id'],
                limit: DELETED_ID_BATCH_SIZE,
            });
            const ids = Array.from(new Set(
                results
                    .map(row => row.id)
                    .filter((id): id is string => typeof id === 'string' && id.length > 0),
            ));
            if (ids.length === 0) {
                break;
            }
            if (previousPageIds && ids.some(id => previousPageIds!.has(id))) {
                throw new Error(`VectorDatabase.deleteDocuments made no progress deleting chunks in '${collectionName}'.`);
            }
            options?.assertMutationCurrent?.();
            await vectorDatabase.deleteDocuments(collectionName, ids);
            batchDeleted += ids.length;
            if (results.length < DELETED_ID_BATCH_SIZE) {
                break;
            }
            previousPageIds = new Set(ids);
        }

        if (batchDeleted > 0) {
            totalDeleted += batchDeleted;
            options?.onBatchDeleted?.(batchDeleted, batch.length);
        }
    }

    return totalDeleted;
}
