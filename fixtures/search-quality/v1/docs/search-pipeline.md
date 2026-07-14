# Search pipeline fixture

The public `searchCodebase` entry calls `planQuery`, then `executeSearch`.
Candidate retrieval uses `retrieveCandidates` and optional
`expandSemanticCandidates`. Ranking uses `rankCandidates`,
`normalizeSourceScores`, and `applyRoleBoosts`. Final selection uses
`finalizeResults` and `selectEvidenceGroups`.

Checkpoint documentation mentions `writeSourceCheckpoint`,
`SOURCE_CHECKPOINT_MISSING`, `refreshCheckpoint`, and `RERANK_TOP_K`, but this
file owns no runtime behavior.
