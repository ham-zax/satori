#!/usr/bin/env bash
# Counts instructions executed by a command. Instruction counts are a
# deterministic proxy for CPU time: use them for CI gates and ratchets where wall
# clock is too noisy.
#
#   instr-count.sh [--backend auto|valgrind|perf|macos] [--out FILE] [--annotate N] -- <command> [args...]
#
# Backends (auto picks the first that works):
#   valgrind  Linux/WSL. Exact and machine-independent. ~20-80x slower than native.
#   perf      Linux on bare metal or VMs that expose PMU counters (WSL2 usually does not).
#             Hardware counter: near-deterministic on one machine, small run-to-run jitter.
#   macos     macOS `/usr/bin/time -l` "instructions retired" (macOS 13+). Same caveat as perf.
# Windows has no backend here: run this under WSL, or see references/tools-by-os.md.
#
# For Node, pass `node --predictable` so V8 runs single-threaded with
# deterministic GC/compilation scheduling:
#   instr-count.sh -- node --predictable --random-seed=1 bench/case.mjs
#
# Prints `instructions <N> backend <name>` on the last stdout line. --annotate N
# (valgrind only) also prints the top N native functions; JIT frames show as ???,
# so attribute JavaScript with call-counts.mjs or a CPU profile instead.
set -euo pipefail

backend="auto"
out=""
annotate=0
while [[ $# -gt 0 ]]; do
    case "$1" in
        --backend) backend="$2"; shift 2 ;;
        --out) out="$2"; shift 2 ;;
        --annotate) annotate="$2"; shift 2 ;;
        --) shift; break ;;
        -h|--help) sed -n '2,21p' "$0"; exit 0 ;;
        *) echo "unknown option: $1" >&2; exit 2 ;;
    esac
done
[[ $# -gt 0 ]] || { echo "usage: instr-count.sh [--backend B] [--out FILE] [--annotate N] -- <command> [args...]" >&2; exit 2; }

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

perf_works() {
    command -v perf >/dev/null && perf stat -x, -e instructions:u true 2>&1 >/dev/null | grep -q '^[0-9]'
}

if [[ "$backend" == "auto" ]]; then
    if command -v valgrind >/dev/null && [[ "$(uname -s)" == "Linux" ]]; then backend=valgrind
    elif perf_works; then backend=perf
    elif [[ "$(uname -s)" == "Darwin" ]]; then backend=macos
    else
        echo "no instruction-count backend: install valgrind (Linux/WSL) or perf with PMU access; see references/tools-by-os.md" >&2
        exit 3
    fi
fi

case "$backend" in
    valgrind)
        command -v valgrind >/dev/null || { echo "valgrind not found" >&2; exit 3; }
        cg_out="${out:-$tmp/cachegrind.out}"
        # --smc-check=all-non-file: JITs (V8, JVM, .NET, PyPy) write and patch code in anonymous memory.
        valgrind --tool=cachegrind --cache-sim=no --branch-sim=no \
            --smc-check=all-non-file --cachegrind-out-file="$cg_out" \
            --log-file="$tmp/valgrind.log" "$@"
        count="$(sed -n 's/^summary: *\([0-9][0-9]*\).*/\1/p' "$cg_out" | head -n 1)"
        if [[ "$annotate" -gt 0 ]] && command -v cg_annotate >/dev/null; then
            cg_annotate --auto=no "$cg_out" 2>/dev/null \
                | sed -n '/[Ff]unction summary/,$p' | head -n "$((annotate + 4))" | cut -c1-200
        fi
        ;;
    perf)
        perf_works || { echo "perf instruction counter unavailable (not installed, no PMU, or perf_event_paranoid)" >&2; exit 3; }
        perf stat -x, -o "$tmp/perf.csv" -e instructions:u -- "$@"
        count="$(awk -F, '/instructions/ { print $1; exit }' "$tmp/perf.csv")"
        ;;
    macos)
        [[ "$(uname -s)" == "Darwin" ]] || { echo "macos backend needs macOS" >&2; exit 3; }
        /usr/bin/time -l -o "$tmp/time.txt" "$@"
        count="$(awk '/instructions retired/ { print $1; exit }' "$tmp/time.txt")"
        ;;
    *) echo "unknown backend: $backend" >&2; exit 2 ;;
esac

[[ "$count" =~ ^[0-9]+$ ]] || { echo "could not read an instruction count (backend $backend)" >&2; exit 1; }
echo "instructions $count backend $backend"
