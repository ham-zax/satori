import {
  TerminalFrame,
  formatDuration,
  isInteractiveTerminal,
} from './terminal-frame.mjs';

const SPINNER = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

function color(code, text) {
  if (process.env.NO_COLOR) return text;
  return `\x1b[${code}m${text}\x1b[0m`;
}

const green = (value) => color('32', value);
const red = (value) => color('31', value);
const cyan = (value) => color('36', value);
const dim = (value) => color('90', value);
const bold = (value) => color('1', value);

function spinnerFrame() {
  return SPINNER[Math.floor(Date.now() / 80) % SPINNER.length];
}

export class ReleaseProgress {
  #timer = null;
  #writeStream;
  #suspended = false;

  constructor(phases, {
    interactive = isInteractiveTerminal(),
    write = (chunk) => process.stdout.write(chunk),
  } = {}) {
    this.interactive = interactive;
    this.#writeStream = write;
    this.frame = new TerminalFrame({
      interactive: this.interactive,
    });

    this.startedAt = Date.now();

    this.phases = phases.map((phase) => ({
      ...phase,
      status: 'pending',
      startedAt: null,
      finishedAt: null,
    }));
  }

  #startTimer() {
    if (!this.interactive || this.#suspended || this.#timer !== null) return;
    this.#timer = setInterval(() => {
      this.write();
    }, 80);
  }

  #stopTimer() {
    if (this.#timer !== null) {
      clearInterval(this.#timer);
      this.#timer = null;
    }
  }

  start(index) {
    const phase = this.phases[index];
    if (!phase) return;

    phase.status = 'running';
    phase.startedAt = Date.now();

    if (this.interactive) {
      this.write();
      this.#startTimer();
    }
  }

  complete(index) {
    const phase = this.phases[index];
    if (!phase) return;

    phase.status = 'passed';
    phase.finishedAt = Date.now();

    if (this.interactive) {
      this.write();
    } else {
      const duration = formatDuration(phase.finishedAt - phase.startedAt);
      this.#writeStream(`[release] PASS ${phase.label} ${duration}\n`);
    }
  }

  fail(index) {
    this.#stopTimer();
    const phase = this.phases[index];
    if (!phase) return;

    phase.status = 'failed';
    phase.finishedAt = Date.now();

    if (this.interactive) {
      this.write();
    } else {
      const duration = formatDuration(phase.finishedAt - (phase.startedAt ?? Date.now()));
      this.#writeStream(`[release] FAIL ${phase.label} ${duration}\n`);
    }
  }

  clear() {
    this.#stopTimer();
    if (!this.interactive) return;
    this.#writeStream(this.frame.clear());
  }

  suspend() {
    if (!this.interactive) return;
    this.#suspended = true;
    this.clear();
  }

  resume() {
    if (!this.interactive || !this.#suspended) return;
    this.#suspended = false;
    this.write();
    if (this.phases.some((phase) => phase.status === 'running')) {
      this.#startTimer();
    }
  }

  redraw() {
    this.write();
  }

  lines() {
    const lines = [
      `${cyan('◆')} ${bold('Satori release qualification')} ${dim(
        formatDuration(Date.now() - this.startedAt),
      )}`,
      '',
    ];

    for (const phase of this.phases) {
      let icon = dim('○');

      if (phase.status === 'running') {
        icon = cyan(spinnerFrame());
      }

      if (phase.status === 'passed') {
        icon = green('✓');
      }

      if (phase.status === 'failed') {
        icon = red('✖');
      }

      let duration = '';

      if (phase.startedAt) {
        const end = phase.finishedAt ?? Date.now();

        duration = dim(
          formatDuration(end - phase.startedAt),
        );
      }

      lines.push(
        `  ${icon} ${phase.label}`
        + (duration ? `  ${duration}` : ''),
      );
    }

    return lines;
  }

  write() {
    if (!this.interactive || this.#suspended) return;

    this.#writeStream(
      this.frame.render(this.lines()),
    );
  }

  finish() {
    this.clear();

    const elapsed = formatDuration(
      Date.now() - this.startedAt,
    );

    this.#writeStream(
      `\n${green('✓')} ${bold('Release qualification passed')} ${dim(elapsed)}\n\n`,
    );
  }
}
