export type SearchRoute = 'exact' | 'lexical' | 'structural' | 'conceptual';

export interface SearchPlan {
    query: string;
    route: SearchRoute;
}
export function planQuery(query: string): SearchPlan {
    if (/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(query)) {
        return { query, route: 'exact' };
    }
    if (query.includes('"')) {
        return { query, route: 'lexical' };
    }
    if (/caller|architecture|trace/i.test(query)) {
        return { query, route: 'structural' };
    }
    return { query, route: 'conceptual' };
}
