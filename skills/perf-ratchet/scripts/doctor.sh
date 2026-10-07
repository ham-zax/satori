#!/usr/bin/env bash
# Reports which performance-measurement tools are available for this OS and
# repository, and prints the install command for each missing one. It never
# installs anything: the agent shows the commands to the user and asks.
#
#   doctor.sh [repo-dir]
#
# Linux, WSL and macOS (bash 3.2 compatible). On native Windows use doctor.ps1.
set -uo pipefail

repo="${1:-.}"
os="$(uname -s)"
platform="$os"
if [[ "$os" == "Linux" ]] && grep -qi microsoft /proc/version 2>/dev/null; then platform="WSL"; fi

pm=""
for candidate in brew apt-get dnf pacman zypper apk; do
    if command -v "$candidate" >/dev/null; then pm="$candidate"; break; fi
done
[[ "$os" == "Darwin" ]] && pm="brew"

# install_cmd <package-for-apt> <package-for-brew> [package-for-dnf] [package-for-pacman]
install_cmd() {
    local apt_pkg="$1" brew_pkg="$2" dnf_pkg="${3:-$1}" pac_pkg="${4:-$1}"
    case "$pm" in
        brew) [[ -n "$brew_pkg" ]] && echo "brew install $brew_pkg" || echo "(not available on macOS)" ;;
        apt-get) echo "sudo apt-get install -y $apt_pkg" ;;
        dnf) echo "sudo dnf install -y $dnf_pkg" ;;
        pacman) echo "sudo pacman -S --needed $pac_pkg" ;;
        zypper) echo "sudo zypper install $apt_pkg" ;;
        apk) echo "sudo apk add $apt_pkg" ;;
        *) echo "install $apt_pkg with your package manager" ;;
    esac
}

missing=0
check() { # check <label> <command> <install-hint> [why]
    local label="$1" cmd="$2" hint="$3" why="${4:-}"
    if command -v "$cmd" >/dev/null; then
        printf '  ok       %-16s %s\n' "$label" "$(command -v "$cmd")"
    else
        missing=$((missing + 1))
        printf '  MISSING  %-16s %s\n' "$label" "$why"
        printf '           install: %s\n' "$hint"
    fi
}

echo "platform: $platform ($(uname -m)), package manager: ${pm:-none found}"
echo "cores: $(getconf _NPROCESSORS_ONLN 2>/dev/null || echo '?')"
if [[ -r /proc/loadavg ]]; then echo "load: $(cut -d' ' -f1-3 /proc/loadavg)"; else echo "load: $(uptime | sed 's/.*load average[s]*: //')"; fi

echo
echo "wall clock and memory"
check hyperfine hyperfine "$(install_cmd hyperfine hyperfine) (or: cargo install hyperfine)" "repeatable wall-clock runs with warmup, median, outliers"
if [[ "$os" == "Darwin" ]]; then
    printf '  ok       %-16s %s\n' "time -l" "/usr/bin/time (BSD: peak RSS, instructions retired on macOS 13+)"
elif /usr/bin/time -v true >/dev/null 2>&1; then
    printf '  ok       %-16s %s\n' "time -v" "/usr/bin/time (GNU: peak RSS)"
else
    missing=$((missing + 1))
    printf '  MISSING  %-16s %s\n' "GNU time" "peak memory per run"
    printf '           install: %s\n' "$(install_cmd time "" time time)"
fi

echo
echo "deterministic counts"
if [[ "$os" == "Darwin" ]]; then
    printf '  info     %-16s %s\n' valgrind "not supported on Apple Silicon; use time -l (instructions retired) or Instruments CPU Counters"
else
    check valgrind valgrind "$(install_cmd valgrind valgrind)" "exact instruction counts (cachegrind/callgrind)"
    if command -v perf >/dev/null; then
        if perf stat -x, -e instructions:u true 2>&1 >/dev/null | grep -q '^[0-9]'; then
            printf '  ok       %-16s %s\n' perf "hardware instruction counter readable"
        else
            printf '  info     %-16s %s\n' perf "installed, but instruction counter unavailable (VM/WSL without PMU, or perf_event_paranoid); use valgrind"
        fi
    elif [[ "$platform" != "WSL" ]]; then
        check perf perf "$(install_cmd "linux-tools-common linux-tools-$(uname -r)" "" perf perf)" "hardware counters, sampling profiles"
    fi
fi

echo
echo "stack-specific (detected in $repo)"
found_stack=0
if [[ -f "$repo/package.json" ]]; then
    found_stack=1
    check node node "https://nodejs.org or nvm/fnm/volta" "--cpu-prof, NODE_V8_COVERAGE call counts, --predictable"
    if grep -Eq '"(react|next|vue|svelte|@angular/core|solid-js|vite)"' "$repo/package.json" 2>/dev/null; then
        browser="chromium"
        for b in chromium chromium-browser google-chrome google-chrome-stable; do
            if command -v "$b" >/dev/null; then browser="$b"; break; fi
        done
        check chromium "$browser" "npx playwright install chromium (or use the harness's browser tool)" \
            "headless frame stepping, CDP Performance.getMetrics"
    fi
fi
if [[ -f "$repo/pyproject.toml" || -f "$repo/requirements.txt" || -f "$repo/setup.py" ]]; then
    found_stack=1
    check python3 python3 "$(install_cmd python3 python)" ""
    check py-spy py-spy "uv tool install py-spy (or pipx install py-spy)" "sampling profiler, attach to running process"
    check pyperf pyperf "uv tool install pyperf" "calibrated wall-clock benchmarks"
fi
if [[ -f "$repo/go.mod" ]]; then
    found_stack=1
    check go go "$(install_cmd golang go)" "go test -bench -benchmem (allocs/op is deterministic)"
    check benchstat benchstat "go install golang.org/x/perf/cmd/benchstat@latest" "statistical before/after comparison"
fi
if [[ -f "$repo/Cargo.toml" ]]; then
    found_stack=1
    check cargo cargo "https://rustup.rs" ""
    check samply samply "cargo install --locked samply" "sampling profiler with Firefox Profiler UI"
    check iai-callgrind iai-callgrind-runner "cargo install --locked iai-callgrind-runner (match the crate version)" "instruction-count benchmarks in Rust"
fi
if ls "$repo"/pom.xml "$repo"/build.gradle* >/dev/null 2>&1; then
    found_stack=1
    check java java "$(install_cmd default-jdk openjdk)" "JMH benchmarks, -prof gc allocation rate"
    check asprof asprof "https://github.com/async-profiler/async-profiler/releases" "low-overhead CPU/alloc profiler"
fi
if ls "$repo"/*.sln "$repo"/*.csproj >/dev/null 2>&1; then
    found_stack=1
    check dotnet dotnet "https://dot.net" "BenchmarkDotNet with MemoryDiagnoser"
    check dotnet-trace dotnet-trace "dotnet tool install -g dotnet-trace" "EventPipe traces"
    check dotnet-counters dotnet-counters "dotnet tool install -g dotnet-counters" "live GC/alloc/threadpool counters"
fi
[[ "$found_stack" -eq 1 ]] || echo "  (no known manifest found; pass the repo path, or pick tools from references/stacks.md)"

echo
if [[ "$missing" -gt 0 ]]; then
    echo "$missing tool(s) missing. Ask the user before installing; commands needing sudo must be run by the user."
else
    echo "all checked tools present."
fi
