import {
  TerminalFrame,
  formatDuration,
  shortPath,
  isInteractiveTerminal,
} from './progress/terminal-frame.mjs';

const SPINNER = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

const MAX_ACTIVE = 3;
const MAX_RECENT = 3;
const REFRESH_MS = 80;

// One test file is the unit of parallelism, so the slowest file bounds the wall
// time of a suite. A file over budget fails the run; split it instead of raising
// the budget. SATORI_TEST_FILE_BUDGET_MS=0 disables the check.
const DEFAULT_FILE_BUDGET_MS = 90_000;

function fileBudgetMs() {
  const configured = Number(process.env.SATORI_TEST_FILE_BUDGET_MS);
  return Number.isFinite(configured) && configured >= 0 ? configured : DEFAULT_FILE_BUDGET_MS;
}

function packageLabel() {
  const cwd = process.cwd().replaceAll('\\', '/');

  if (cwd.endsWith('/packages/core')) return 'Core';
  if (cwd.endsWith('/packages/mcp')) return 'MCP';
  if (cwd.endsWith('/packages/cli')) return 'CLI';

  return 'Satori';
}

function color(code, text) {
  if (process.env.NO_COLOR) return text;
  return `\x1b[${code}m${text}\x1b[0m`;
}

const cyan = (value) => color('36', value);
const green = (value) => color('32', value);
const red = (value) => color('31', value);
const yellow = (value) => color('33', value);
const dim = (value) => color('90', value);
const bold = (value) => color('1', value);

function spinnerFrame() {
  return SPINNER[Math.floor(Date.now() / 80) % SPINNER.length];
}

function createState() {
  return {
    label: packageLabel(),
    startedAt: Date.now(),

    active: new Map(),
    recent: [],

    completedFiles: 0,

    passed: 0,
    failed: 0,
    skipped: 0,

    failures: [],
    fileBudgetMs: fileBudgetMs(),
    overBudget: [],
  };
}

function ensureActiveFile(state, file) {
  if (!file) return null;

  let entry = state.active.get(file);

  if (!entry) {
    entry = {
      file,
      startedAt: Date.now(),
      completedTests: 0,
      failedTests: 0,
    };

    state.active.set(file, entry);
  }

  return entry;
}

function topActiveFiles(state) {
  return [...state.active.values()]
    .sort((a, b) => a.startedAt - b.startedAt)
    .slice(0, MAX_ACTIVE);
}

function renderActiveLine(entry) {
  const elapsed = formatDuration(Date.now() - entry.startedAt);
  const count = entry.completedTests;

  return (
    `  ${cyan(spinnerFrame())} `
    + `${bold(shortPath(entry.file))}`
    + `  ${dim(`${count} test${count === 1 ? '' : 's'} · ${elapsed}`)}`
  );
}

function renderRecentLine(entry) {
  const status = entry.failed > 0
    ? red('✖')
    : green('✓');

  const count = `${entry.passed} test${entry.passed === 1 ? '' : 's'}`;

  return (
    `  ${status} `
    + `${shortPath(entry.file)}`
    + `  ${dim(`${count} · ${formatDuration(entry.durationMs)}`)}`
  );
}

function buildDashboard(state) {
  const elapsed = formatDuration(Date.now() - state.startedAt);
  const active = topActiveFiles(state);
  const hiddenActive = Math.max(0, state.active.size - active.length);

  const lines = [
    `${cyan('◆')} ${bold(`${state.label} tests`)} ${dim(elapsed)}`,
  ];

  if (active.length > 0) {
    lines.push('', `  ${dim('RUNNING')}`);
    for (const entry of active) {
      lines.push(renderActiveLine(entry));
    }
    if (hiddenActive > 0) {
      lines.push(`    ${dim(`+${hiddenActive} more running`)}`);
    }
  }

  lines.push('', `  ${dim('PROGRESS')}`);

  const failed = state.failed > 0
    ? ` · ${red(`${state.failed} failed`)}`
    : '';

  const skipped = state.skipped > 0
    ? ` · ${yellow(`${state.skipped} skipped`)}`
    : '';

  lines.push(
    `  ${state.completedFiles} files completed`
    + ` · ${green(`${state.passed} passed`)}`
    + failed
    + skipped
    + ` · ${state.active.size} running`,
  );

  const recent = state.recent.slice(0, MAX_RECENT);
  if (recent.length > 0) {
    lines.push('', `  ${dim('RECENT')}`);
    for (const entry of recent) {
      lines.push(renderRecentLine(entry));
    }
  }

  return lines;
}

function failureBlock(failure) {
  const lines = [
    '',
    `${red('✖ FAIL')} ${bold(failure.name)}`,
    `  ${dim(shortPath(failure.file, 3))}`,
  ];

  if (failure.error?.stack) {
    lines.push(
      ...String(failure.error.stack)
        .split('\n')
        .slice(0, 8)
        .map((line) => `  ${line}`),
    );
  } else if (failure.error?.message) {
    lines.push(`  ${failure.error.message}`);
  }

  lines.push('');

  return lines.join('\n');
}

function finalSummary(state) {
  const elapsed = formatDuration(Date.now() - state.startedAt);

  if (state.failed === 0) {
    const skippedNote = state.skipped ? ` · ${yellow(`${state.skipped} skipped`)}` : '';
    return [
      '',
      `${green('✓')} ${bold(`${state.label} tests passed`)}`,
      '',
      `  ${green(`${state.passed} passed`)}${skippedNote}`,
      `  ${state.completedFiles} files · ${elapsed}`,
      '',
    ].join('\n');
  }

  return [
    '',
    `${red('✖')} ${bold(`${state.label} tests failed`)}`,
    '',
    `  ${red(`${state.failed} failed`)} · ${state.passed} passed`,
    `  ${state.completedFiles} files · ${elapsed}`,
    '',
  ].join('\n');
}

function overBudgetBlock(state) {
  return [
    '',
    `${red('✖')} ${bold('Test files over the time budget')} ${dim(`(${formatDuration(state.fileBudgetMs)} per file)`)}`,
    ...state.overBudget.map((entry) => `  ${shortPath(entry.file, 3)}  ${dim(formatDuration(entry.durationMs))}`),
    `  ${dim('Split the file so its tests run in parallel.')}`,
    '',
  ].join('\n');
}

function plainFileSummary(data) {
  const counts = data.counts ?? {};

  const passed = counts.passed ?? 0;
  const failed = counts.failed ?? 0;
  const skipped = counts.skipped ?? 0;

  const status = failed > 0 ? 'FAIL' : 'PASS';

  return (
    `[test] ${status} ${shortPath(data.file, 3)}`
    + ` ${passed} passed`
    + (failed ? ` ${failed} failed` : '')
    + (skipped ? ` ${skipped} skipped` : '')
    + '\n'
  );
}

class AsyncChannel {
  #queue = [];
  #resolvers = [];

  push(item) {
    if (this.#resolvers.length > 0) {
      this.#resolvers.shift()({ value: item, done: false });
    } else {
      this.#queue.push(item);
    }
  }

  close() {
    while (this.#resolvers.length > 0) {
      this.#resolvers.shift()({ value: undefined, done: true });
    }
  }

  async *[Symbol.asyncIterator]() {
    while (true) {
      if (this.#queue.length > 0) {
        yield this.#queue.shift();
      } else {
        const next = await new Promise((r) => this.#resolvers.push(r));
        if (next.done) break;
        yield next.value;
      }
    }
  }
}

export default async function* satoriTestReporter(source) {
  const state = createState();
  const interactive = isInteractiveTerminal();
  const frame = new TerminalFrame({ interactive });

  const channel = new AsyncChannel();
  let timer = null;

  if (interactive) {
    timer = setInterval(() => {
      channel.push({ type: 'tick' });
    }, REFRESH_MS);
  }

  (async () => {
    try {
      for await (const event of source) {
        channel.push({ type: 'event', value: event });
      }
    } finally {
      channel.push({ type: 'done' });
    }
  })();

  for await (const message of channel) {
    if (message.type === 'tick') {
      if (state.active.size > 0) {
        yield frame.render(buildDashboard(state));
      }
      continue;
    }

    if (message.type === 'done') {
      if (timer !== null) {
        clearInterval(timer);
        timer = null;
      }
      break;
    }

    const event = message.value;
    const data = event.data ?? {};

    if (event.type === 'test:start') {
      if (data.file) {
        ensureActiveFile(state, data.file);
        if (interactive) {
          yield frame.render(buildDashboard(state));
        }
      }
    } else if (event.type === 'test:pass') {
      state.passed += 1;
      if (data.file) {
        const entry = ensureActiveFile(state, data.file);
        entry.completedTests += 1;
      }
    } else if (event.type === 'test:fail') {
      state.failed += 1;
      const entry = data.file ? ensureActiveFile(state, data.file) : null;
      if (entry) {
        entry.failedTests += 1;
        entry.completedTests += 1;
      }
      const error = data.details?.error ?? data.error;
      const failure = {
        name: data.name ?? 'unnamed test',
        file: data.file ?? 'unknown',
        error,
      };
      state.failures.push(failure);

      if (interactive) {
        yield frame.clear();
        yield `${failureBlock(failure)}\n`;
        frame.reset();
      } else {
        yield `${failureBlock(failure)}\n`;
      }
    } else if (event.type === 'test:summary') {
      if (data.file) {
        const entry = state.active.get(data.file);
        state.active.delete(data.file);
        state.completedFiles += 1;

        const counts = data.counts ?? {};
        const recent = {
          file: data.file,
          passed: counts.passed ?? entry?.completedTests ?? 0,
          failed: counts.failed ?? entry?.failedTests ?? 0,
          skipped: counts.skipped ?? 0,
          durationMs: data.duration_ms ?? (entry ? Date.now() - entry.startedAt : 0),
        };

        if (state.fileBudgetMs > 0 && recent.durationMs > state.fileBudgetMs) {
          state.overBudget.push(recent);
        }
        state.skipped += recent.skipped;
        state.recent.unshift(recent);
        state.recent = state.recent.slice(0, MAX_RECENT);

        if (!interactive) {
          yield plainFileSummary(data);
        } else if (state.active.size > 0) {
          yield frame.render(buildDashboard(state));
        }
      } else {
        if (timer !== null) {
          clearInterval(timer);
          timer = null;
        }
        if (interactive) {
          yield frame.clear();
        }
        yield `${finalSummary(state)}\n`;
        if (state.overBudget.length > 0) {
          yield `${overBudgetBlock(state)}\n`;
          process.exitCode = 1;
        }
      }
    }
  }

  if (timer !== null) {
    clearInterval(timer);
    timer = null;
  }
  if (interactive) {
    yield frame.clear();
  }
}
