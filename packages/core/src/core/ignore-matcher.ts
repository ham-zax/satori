import ignore from 'ignore';
import { DEFAULT_IGNORE_PATTERNS } from '../config/defaults';

/**
 * The only matcher surface index-policy consumers rely on. Every matcher built
 * from effective index ignore patterns comes from `createIndexIgnoreMatcher`,
 * which is the single owner of the "built-in denylist is not overridable" rule.
 */
export type IndexIgnoreMatcher = Readonly<{
    ignores(relativePath: string): boolean;
}>;

const hardDenylist = ignore().add([...DEFAULT_IGNORE_PATTERNS]);

/**
 * Build a matcher for an effective ignore list (base + custom + file-based).
 * A path is ignored when the built-in denylist matches it or the effective
 * list's last-match-wins evaluation ignores it, so a `!` rule in user input
 * can never re-include a denylisted path.
 */
export function createIndexIgnoreMatcher(effectivePatterns: readonly string[]): IndexIgnoreMatcher {
    const userMatcher = ignore().add([...effectivePatterns]);
    return {
        ignores: (relativePath: string): boolean => (
            hardDenylist.ignores(relativePath) || userMatcher.ignores(relativePath)
        ),
    };
}
