# Reports which performance-measurement tools are available on native Windows
# and prints the install command for each missing one. It never installs
# anything: the agent shows the commands to the user and asks.
#
#   powershell -ExecutionPolicy Bypass -File doctor.ps1 [repo-dir]
#
# Valgrind and perf do not run on native Windows. For exact instruction counts,
# run instr-count.sh inside WSL, or use Intel SDE / WPR hardware counters
# (references/tools-by-os.md).
param([string]$Repo = ".")

$missing = 0
function Check($Label, $Cmd, $Install, $Why) {
    $found = Get-Command $Cmd -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($found) {
        "  ok       {0,-16} {1}" -f $Label, $found.Source
    } else {
        $script:missing++
        "  MISSING  {0,-16} {1}" -f $Label, $Why
        "           install: $Install"
    }
}

$pm = if (Get-Command winget -ErrorAction SilentlyContinue) { "winget" }
      elseif (Get-Command scoop -ErrorAction SilentlyContinue) { "scoop" }
      elseif (Get-Command choco -ErrorAction SilentlyContinue) { "choco" }
      else { "none found" }
"platform: Windows $([Environment]::OSVersion.Version) ($env:PROCESSOR_ARCHITECTURE), package manager: $pm"
"cores: $([Environment]::ProcessorCount)"
""
"wall clock and memory"
Check "hyperfine" "hyperfine" "winget install sharkdp.hyperfine  (or: scoop install hyperfine)" "repeatable wall-clock runs"
"  info     Measure-Command  built in; single run only, use hyperfine for medians"
""
"profiling and counters"
Check "wpr" "wpr" "built into Windows 10+ (Windows Performance Toolkit adds WPA: winget install Microsoft.WindowsADK)" "ETW traces, PMC counters such as InstructionRetired"
Check "wsl" "wsl" "wsl --install  (then run doctor.sh and instr-count.sh inside WSL)" "valgrind instruction counts via WSL"
""
"stack-specific (detected in $Repo)"
if (Test-Path (Join-Path $Repo "package.json")) {
    Check "node" "node" "winget install OpenJS.NodeJS.LTS" "--cpu-prof, NODE_V8_COVERAGE call counts"
}
if ((Test-Path (Join-Path $Repo "pyproject.toml")) -or (Test-Path (Join-Path $Repo "requirements.txt"))) {
    Check "python" "python" "winget install Python.Python.3.12" ""
    Check "py-spy" "py-spy" "uv tool install py-spy" "sampling profiler"
}
if (Test-Path (Join-Path $Repo "go.mod")) {
    Check "go" "go" "winget install GoLang.Go" "go test -bench -benchmem"
    Check "benchstat" "benchstat" "go install golang.org/x/perf/cmd/benchstat@latest" "before/after statistics"
}
if (Test-Path (Join-Path $Repo "Cargo.toml")) {
    Check "cargo" "cargo" "winget install Rustlang.Rustup" ""
    Check "samply" "samply" "cargo install --locked samply" "sampling profiler"
}
if (Get-ChildItem -Path $Repo -Filter *.csproj -ErrorAction SilentlyContinue | Select-Object -First 1) {
    Check "dotnet" "dotnet" "winget install Microsoft.DotNet.SDK.8" "BenchmarkDotNet"
    Check "dotnet-trace" "dotnet-trace" "dotnet tool install -g dotnet-trace" "EventPipe traces"
    Check "dotnet-counters" "dotnet-counters" "dotnet tool install -g dotnet-counters" "live GC/alloc counters"
}
""
if ($missing -gt 0) {
    "$missing tool(s) missing. Ask the user before installing; elevated installs must be run by the user."
} else {
    "all checked tools present."
}
