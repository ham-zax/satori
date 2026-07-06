export function escapeMilvusStringLiteral(value: string): string {
    return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

export function buildMilvusIdInFilter(ids: string[]): string {
    return `id in [${ids.map((id) => `"${escapeMilvusStringLiteral(id)}"`).join(', ')}]`;
}
