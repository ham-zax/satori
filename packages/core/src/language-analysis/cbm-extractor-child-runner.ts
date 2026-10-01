import { cbmExtractorHost, CbmExtractorUnavailableError } from './cbm-extractor-host';

async function main(): Promise<void> {
    try {
        let input = '';
        process.stdin.setEncoding('utf8');
        for await (const chunk of process.stdin) input += chunk;
        const request = JSON.parse(input) as Record<string, unknown>;
        const { assetRoot, language, relativePath, source } = request;
        if (typeof assetRoot !== 'string' || typeof language !== 'string'
            || typeof relativePath !== 'string' || typeof source !== 'string') {
            throw new Error('Invalid CBM extractor child request');
        }
        const records = await cbmExtractorHost(assetRoot).extractInProcess(language, relativePath, source);
        process.stdout.write(JSON.stringify({ records }));
    } catch (error) {
        process.stdout.write(JSON.stringify({
            error: error instanceof Error ? error.message : String(error),
            unavailable: error instanceof CbmExtractorUnavailableError,
        }));
    }
}

void main();
