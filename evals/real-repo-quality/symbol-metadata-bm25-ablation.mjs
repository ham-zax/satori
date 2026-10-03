// Reuse the fixed-publication owner trace and controls; compare only the metadata retrieval flag.
process.env.OWNER_PREFERENCE_EVAL_FLAG = 'symbol_metadata_bm25';
process.env.OWNER_PREFERENCE_EVAL_REPEATS = '3';
process.env.OWNER_PREFERENCE_EVAL_OUTPUT ??= '/tmp/satori-symbol-metadata-bm25.json';
await import('./neutral-owner-preference-ablation.mjs');
