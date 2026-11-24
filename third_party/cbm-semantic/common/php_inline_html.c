// php_inline_html.c — let the php_only grammar read a file that leaves PHP mode.
// Ported from Codebase Memory MCP (#2000, commits 09dc36d2, 0843106f).

#include "cbm.h"
#include <stdbool.h>
#include <stddef.h>
#include <string.h>

enum {
    PHP_TAG_OPEN_LEN = 5,  /* <?php */
    PHP_TAG_ECHO_LEN = 3,  /* <?= */
    PHP_TAG_SHORT_LEN = 2, /* <? */
    PHP_HEREDOC_LEN = 3,   /* <<< */
    PHP_FIRST_NON_ASCII = 0x80,
    PHP_NOT_FOUND = -1,
};

static const char PHP_HALT_COMPILER[] = "__halt_compiler";
enum { PHP_HALT_COMPILER_LEN = (int)sizeof(PHP_HALT_COMPILER) - SKIP_ONE };

static bool php_at(const char *s, int len, int i, const char *lit) {
    size_t n = strlen(lit);
    return i >= 0 && i <= len && (size_t)(len - i) >= n && memcmp(s + i, lit, n) == 0;
}

static bool php_is_ident_char(unsigned char c) {
    return c == '_' || (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9') ||
           c >= PHP_FIRST_NON_ASCII;
}

static bool php_is_ident_start(unsigned char c) {
    return php_is_ident_char(c) && !(c >= '0' && c <= '9');
}

static bool php_is_space(unsigned char c) {
    return c == ' ' || c == '\t' || c == '\n' || c == '\r' || c == '\f' || c == '\v';
}

static bool php_is_blank(char c) {
    return c == ' ' || c == '\t';
}

static bool php_ieq(const char *s, int len, int i, const char *word) {
    int n = (int)strlen(word);
    if (i + n > len) {
        return false;
    }
    for (int k = 0; k < n; k++) {
        char c = s[i + k];
        if (c >= 'A' && c <= 'Z') {
            c = (char)(c - 'A' + 'a');
        }
        if (c != word[k]) {
            return false;
        }
    }
    return true;
}

static int php_open_tag_len(const char *s, int len, int i) {
    if (!php_at(s, len, i, "<?")) {
        return 0;
    }
    int after = i + PHP_TAG_SHORT_LEN;
    if (php_ieq(s, len, after, "php")) {
        int end = i + PHP_TAG_OPEN_LEN;
        return (end == len || php_is_space((unsigned char)s[end])) ? PHP_TAG_OPEN_LEN : 0;
    }
    if (after < len && s[after] == '=') {
        return PHP_TAG_ECHO_LEN;
    }
    if (after < len && php_is_space((unsigned char)s[after])) {
        return PHP_TAG_SHORT_LEN;
    }
    return 0;
}

static bool php_has_close_tag(const char *s, int len) {
    for (int i = 0; i < len; i++) {
        if (php_at(s, len, i, "?>")) {
            return true;
        }
    }
    return false;
}

static void php_blank(char *out, int from, int to) {
    for (int k = from; k < to; k++) {
        if (out[k] != '\n' && out[k] != '\r') {
            out[k] = ' ';
        }
    }
}

static int php_skip_quoted(const char *s, int len, int i) {
    char quote = s[i];
    i += SKIP_ONE;
    while (i < len && s[i] != quote) {
        i += (s[i] == '\\') ? PAIR_LEN : SKIP_ONE;
    }
    return i < len ? i + SKIP_ONE : len;
}

static int php_skip_block_comment(const char *s, int len, int i) {
    for (int k = i + PAIR_LEN; k < len; k++) {
        if (php_at(s, len, k, "*/")) {
            return k + PAIR_LEN;
        }
    }
    return len;
}

static int php_skip_line_comment(const char *s, int len, int i) {
    while (i < len && s[i] != '\n' && !php_at(s, len, i, "?>")) {
        i++;
    }
    return i;
}

static int php_heredoc_opener(const char *s, int len, int i, int *label, int *label_len) {
    int p = i + PHP_HEREDOC_LEN;
    while (p < len && php_is_blank(s[p])) {
        p++;
    }
    char quote = 0;
    if (p < len && (s[p] == '\'' || s[p] == '"')) {
        quote = s[p];
        p++;
    }
    int start = p;
    while (p < len && php_is_ident_char((unsigned char)s[p])) {
        p++;
    }
    if (p == start || !php_is_ident_start((unsigned char)s[start])) {
        return PHP_NOT_FOUND;
    }
    *label = start;
    *label_len = p - start;
    if (quote) {
        if (p >= len || s[p] != quote) {
            return PHP_NOT_FOUND;
        }
        p++;
    }
    if (p < len && s[p] == '\r') {
        p++;
    }
    return (p < len && s[p] == '\n') ? p : PHP_NOT_FOUND;
}

static bool php_heredoc_closes(const char *s, int len, int p, int label, int label_len, int *end) {
    while (p < len && php_is_blank(s[p])) {
        p++;
    }
    if (len - p < label_len || memcmp(s + p, s + label, (size_t)label_len) != 0) {
        return false;
    }
    int after = p + label_len;
    if (after < len && php_is_ident_char((unsigned char)s[after])) {
        return false;
    }
    *end = after;
    return true;
}

static int php_skip_heredoc(const char *s, int len, int i) {
    int label = 0;
    int label_len = 0;
    int nl = php_heredoc_opener(s, len, i, &label, &label_len);
    if (nl < 0) {
        return i + PHP_HEREDOC_LEN;
    }
    while (nl < len) {
        int line = nl + SKIP_ONE;
        int end = 0;
        if (php_heredoc_closes(s, len, line, label, label_len, &end)) {
            return end;
        }
        const char *next = memchr(s + line, '\n', (size_t)(len - line));
        if (!next) {
            return len;
        }
        nl = (int)(next - s);
    }
    return len;
}

static int php_skip_ident(const char *s, int len, int i, bool *halt) {
    int start = i;
    while (i < len && php_is_ident_char((unsigned char)s[i])) {
        i++;
    }
    bool is_var = start > 0 && s[start - SKIP_ONE] == '$';
    *halt =
        !is_var && i - start == PHP_HALT_COMPILER_LEN && php_ieq(s, len, start, PHP_HALT_COMPILER);
    return i;
}

static int php_scan_code(const char *s, int len, int i) {
    while (i < len) {
        unsigned char c = (unsigned char)s[i];
        if (php_at(s, len, i, "?>")) {
            return i;
        }
        if (c == '\'' || c == '"' || c == '`') {
            i = php_skip_quoted(s, len, i);
        } else if (php_at(s, len, i, "/*")) {
            i = php_skip_block_comment(s, len, i);
        } else if (php_at(s, len, i, "//") || (c == '#' && !php_at(s, len, i, "#["))) {
            i = php_skip_line_comment(s, len, i);
        } else if (php_at(s, len, i, "<<<")) {
            i = php_skip_heredoc(s, len, i);
        } else if (php_is_ident_start(c)) {
            bool halt = false;
            i = php_skip_ident(s, len, i, &halt);
            if (halt) {
                return PHP_NOT_FOUND;
            }
        } else {
            i++;
        }
    }
    return len;
}

typedef struct {
    CBMArena *arena;
    const char *source;
    int len;
    char *out;
    bool failed;
} PHPMask;

static char *php_mask_writable(PHPMask *m) {
    if (!m->out && !m->failed) {
        m->out = (char *)cbm_arena_alloc(m->arena, (size_t)m->len + SKIP_ONE);
        if (m->out) {
            memcpy(m->out, m->source, (size_t)m->len);
            m->out[m->len] = '\0';
        } else {
            m->failed = true;
        }
    }
    return m->out;
}

static void php_mask_blank(PHPMask *m, int from, int to) {
    char *out = php_mask_writable(m);
    if (out) {
        php_blank(out, from, to);
    }
}

static void php_mask_close_tag(PHPMask *m, int i) {
    char *out = php_mask_writable(m);
    if (out) {
        out[i] = ';';
        out[i + SKIP_ONE] = ' ';
    }
}

const char *cbm_php_mask_inline_html(CBMArena *arena, const char *source, int source_len) {
    if (!arena || !source || source_len <= 0) {
        return source;
    }
    if (php_open_tag_len(source, source_len, 0) > 0 && !php_has_close_tag(source, source_len)) {
        return source;
    }

    PHPMask m = {.arena = arena, .source = source, .len = source_len};
    bool seen_open = false;
    int i = 0;
    while (i < source_len && !m.failed) {
        int html_start = i;
        int tag = 0;
        while (i < source_len && (tag = php_open_tag_len(source, source_len, i)) == 0) {
            i++;
        }
        if (i > html_start) {
            php_mask_blank(&m, html_start, i);
        }
        if (i >= source_len) {
            break;
        }
        if (seen_open) {
            php_mask_blank(&m, i, i + tag);
        }
        seen_open = true;

        int close = php_scan_code(source, source_len, i + tag);
        if (close < 0 || close >= source_len) {
            break;
        }
        php_mask_close_tag(&m, close);
        i = close + PAIR_LEN;
    }
    return (m.out && !m.failed) ? m.out : source;
}
