# Tools by operating system

Always ask the user before installing. Commands that need `sudo` or an elevated
shell must be run by the user. In Claude Code, suggest the `! <command>` prefix so the output lands in
the session.

## Capability matrix

| Need | Linux (bare metal/VM) | WSL2 | macOS | Windows (native) |
|---|---|---|---|---|
| Wall clock, repeated | hyperfine | hyperfine | hyperfine | hyperfine |
| Peak memory | `/usr/bin/time -v` (GNU) | `/usr/bin/time -v` | `/usr/bin/time -l` | `Get-Process` PeakWorkingSet64, or `hyperfine` plus Process Explorer |
| Exact instruction count | valgrind (cachegrind/callgrind) | valgrind | not on Apple Silicon (Intel only with an old valgrind) | run it in WSL; or Intel SDE (`sde -mix`) on x86 |
| HW counter (near-deterministic) | `perf stat -e instructions:u` | usually no PMU | `/usr/bin/time -l` "instructions retired" (13+); Instruments CPU Counters | WPR with PMC profile (InstructionRetired) |
| Sampling CPU profile | perf, samply, py-spy, async-profiler | same, minus perf HW events | samply, Instruments Time Profiler, py-spy | WPR/WPA, samply, Visual Studio profiler, py-spy |
| Tracing/timeline | perf trace, bpftrace, ltrace/strace | strace | Instruments, dtrace (SIP limits) | ETW (WPR/WPA), PerfView |
| Browser | Chromium/Chrome headless, Playwright | same | same | same |

## Install commands

| Tool | Debian/Ubuntu | Fedora | Arch | macOS (Homebrew) | Windows |
|---|---|---|---|---|---|
| hyperfine | `sudo apt-get install -y hyperfine` | `sudo dnf install -y hyperfine` | `sudo pacman -S hyperfine` | `brew install hyperfine` | `winget install sharkdp.hyperfine` |
| GNU time | `sudo apt-get install -y time` | `sudo dnf install -y time` | `sudo pacman -S time` | built in (BSD `-l`) | n/a |
| valgrind | `sudo apt-get install -y valgrind` | `sudo dnf install -y valgrind` | `sudo pacman -S valgrind` | n/a on Apple Silicon | inside WSL |
| perf | `sudo apt-get install -y linux-tools-common linux-tools-$(uname -r)` | `sudo dnf install -y perf` | `sudo pacman -S perf` | n/a | n/a (use WPR) |
| samply | `cargo install --locked samply` | same | same | same / `brew install samply` | `cargo install --locked samply` |
| py-spy | `uv tool install py-spy` | same | same | same | same |
| benchstat | `go install golang.org/x/perf/cmd/benchstat@latest` | same | same | same | same |
| dotnet-trace / -counters | `dotnet tool install -g dotnet-trace` | same | same | same | same |
| Chromium for automation | `npx playwright install chromium` | same | same | same | same |
| WPR/WPA | n/a | n/a | n/a | n/a | WPR is built into Windows 10+; WPA via `winget install Microsoft.WindowsADK` |

## Platform notes

- **perf permissions:** if `perf stat` prints `<not supported>` or a permission error, check `/proc/sys/kernel/perf_event_paranoid`. Lowering it, for example with `sudo sysctl kernel.perf_event_paranoid=1`, is a system change: ask first and prefer Valgrind.
- **WSL2:** usually no hardware counters, so use Valgrind. Keep the work on the Linux filesystem; `/mnt/c` I/O is much slower and distorts the wall clock.
- **macOS:** System Integrity Protection limits dtrace. `xctrace record --template 'CPU Counters'` gives instruction counts from Instruments on the command line.
- **Windows:** `wpr -start CPU -start <pmc profile>` then `wpr -stop out.etl`, and open the trace in WPA. `Measure-Command { ... }` is a single sample; use hyperfine for medians.
- **Laptops:** plug in and disable low-power mode. Thermal throttling and power states are the most common cause of false wall-clock regressions.
- **Containers/CI:** shared runners vary 10-30% in wall clock. Gate CI on deterministic counts and track wall clock as a trend only.
