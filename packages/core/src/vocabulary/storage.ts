import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { buildRepositoryVocabularyIndex } from './build';
import { encodeRepositoryVocabularyIndex } from './codec';
import { MAX_VOCABULARY_BYTES, VOCABULARY_FILE } from './contracts';

export const vocabularyHash = (text: string | Buffer): string => crypto.createHash('sha256').update(text).digest('hex');

/** Runs inside the navigation staging directory, before its atomic publication. */
export async function stageRepositoryVocabularyIndex(
    input: Parameters<typeof buildRepositoryVocabularyIndex>[0] & { navigationRoot: string },
): Promise<void> {
    let index = encodeRepositoryVocabularyIndex(buildRepositoryVocabularyIndex(input));
    let payload = JSON.stringify(index);
    if (Buffer.byteLength(payload) > MAX_VOCABULARY_BYTES - 512) {
        index = { ...index, documents: [], dictionary: [], budgetExceeded: true };
        payload = JSON.stringify(index);
    }
    await fs.promises.writeFile(path.join(input.navigationRoot, VOCABULARY_FILE),
        `${JSON.stringify({ payloadHash: vocabularyHash(payload), index })}\n`, { flag: 'wx' });
}

/** Even a malformed artifact cannot make a reader allocate beyond this bound. */
export async function readBoundedVocabularyFile(file: string): Promise<Buffer> {
    const handle = await fs.promises.open(file, 'r');
    try {
        const stat = await handle.stat();
        if (!stat.isFile()) throw new Error('Vocabulary artifact is not a regular file');
        if (stat.size > MAX_VOCABULARY_BYTES) throw new RangeError('Vocabulary artifact exceeds its byte budget');
        const buffer = Buffer.alloc(stat.size + 1);
        let offset = 0;
        while (offset < buffer.length) {
            const read = await handle.read(buffer, offset, buffer.length - offset, offset);
            if (read.bytesRead === 0) break;
            offset += read.bytesRead;
        }
        if (offset !== stat.size) throw new Error('Vocabulary artifact changed while reading');
        return buffer.subarray(0, offset);
    } finally { await handle.close(); }
}
