// Normalizes search_codebase results and scores them against the acceptable-owner sets in cases.json.

const KIND_PREFIX = /^(function|method|class|constructor|interface|type|enum|struct|trait|module|namespace|variable|constant|macro|file)\s+/;

export function normalizeHit({ rank, raw }, classifyPathCategory) {
    const file = raw?.target?.file ?? raw?.file ?? raw?.path ?? null;
    const kind = raw?.symbolKind ?? null;
    const label = typeof raw?.displayLabel === 'string' ? raw.displayLabel : null;
    const isFile = kind === 'file' || (label ? label.startsWith('file ') : false);
    return {
        rank,
        path: file,
        symbol: isFile || !label ? null : label.replace(KIND_PREFIX, ''),
        displayLabel: label,
        kind,
        granularity: isFile ? 'file' : 'symbol',
        span: raw?.target?.span ?? null,
        language: raw?.language ?? null,
        quality: raw?.quality ?? null,
        pathCategory: file ? classifyPathCategory(file) : null,
        raw,
    };
}

function symbolMatches(regex, symbol) {
    if (!symbol) return false;
    const re = new RegExp(regex);
    return re.test(symbol) || re.test(symbol.split('.').at(-1));
}

export function scoreQuery(query, hits) {
    let rank = null;
    let strictRank = null;
    let granularity = null;
    let matched = null;
    for (const hit of hits) {
        for (const owner of query.acceptable) {
            if (!hit.path || !new RegExp(owner.pathRegex).test(hit.path)) continue;
            const symbolOk = owner.symbolRegex ? symbolMatches(owner.symbolRegex, hit.symbol) : true;
            const fileLevelOnPath = hit.granularity === 'file';
            if (symbolOk || fileLevelOnPath) {
                if (rank === null) {
                    rank = hit.rank;
                    granularity = hit.granularity;
                    matched = { path: hit.path, symbol: hit.symbol, owner: owner.pathRegex };
                }
                if (symbolOk && (owner.symbolRegex ? !fileLevelOnPath : true) && strictRank === null) strictRank = hit.rank;
            }
        }
        if (rank !== null && strictRank !== null) break;
    }
    return { rank, strictRank, granularity, matched };
}
