import { spawn } from 'node:child_process';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

const root = '/tmp/satori-python-p1-pyright';
const pyrightSite = '/home/hamza/repo/tradingview_ratio/.venv/lib/python3.12/site-packages';

const cases = [
  {
    id: 'typed-parameter',
    files: {
      'models.py': 'class Service:\n    def run(self): pass\n',
      'app.py': 'from models import Service\n\ndef use(service: Service):\n    service.run()\n',
    },
    file: 'app.py', line: 4, token: 'run', expected: 'models.py:Service.run',
  },
  {
    id: 'forward-ref-parameter',
    files: {
      'models.py': 'class Service:\n    def run(self): pass\n',
      'app.py': 'from models import Service\n\ndef use(service: "Service"):\n    service.run()\n',
    },
    file: 'app.py', line: 4, token: 'run', expected: 'models.py:Service.run',
  },
  {
    id: 'cross-module-constructor',
    files: {
      'models.py': 'class Service:\n    pass\n',
      'app.py': 'from models import Service\n\ndef make():\n    return Service()\n',
    },
    file: 'app.py', line: 4, token: 'Service', expected: 'models.py:Service',
  },
  {
    id: 'local-import-scope-leak',
    files: {
      'models.py': 'def helper(): pass\n',
      'app.py': [
        'def a():',
        '    from models import helper',
        '    helper()',
        '',
        'def b():',
        '    helper()',
      ].join('\n'),
    },
    file: 'app.py', line: 6, token: 'helper', expected: 'abstain',
  },
  {
    id: 'competing-local-import-a',
    files: {
      'alpha.py': 'def helper(): pass\n',
      'beta.py': 'def helper(): pass\n',
      'app.py': [
        'def a():',
        '    from alpha import helper',
        '    helper()',
        '',
        'def b():',
        '    from beta import helper',
        '    helper()',
      ].join('\n'),
    },
    file: 'app.py', line: 3, token: 'helper', expected: 'alpha.py:helper',
  },
  {
    id: 'callback-direct-keyword',
    files: {
      'app.py': [
        'def target(): pass',
        '',
        'def invoke(cb):',
        '    cb()',
        '',
        'def entry():',
        '    invoke(cb=target)',
      ].join('\n'),
    },
    file: 'app.py', line: 4, token: 'cb', expected: 'app.py:target',
  },
  {
    id: 'service-any-keyword',
    files: {
      'app.py': [
        'from typing import Any',
        '',
        'class Ledger:',
        '    def record(self): pass',
        '',
        'class Engine:',
        '    def __init__(self):',
        '        self.ledger = Ledger()',
        '',
        'class Services:',
        '    def __init__(self, ledger: Any):',
        '        self.ledger = ledger',
        '',
        'def consume(services: Services):',
        '    services.ledger.record()',
        '',
        'def entry():',
        '    engine = Engine()',
        '    services = Services(ledger=engine.ledger)',
        '    consume(services=services)',
      ].join('\n'),
    },
    file: 'app.py', line: 15, token: 'record', expected: 'app.py:Ledger.record',
  },
  {
    id: 'service-any-positional',
    files: {
      'app.py': [
        'from typing import Any',
        '',
        'class Ledger:',
        '    def record(self): pass',
        '',
        'class Engine:',
        '    def __init__(self):',
        '        self.ledger = Ledger()',
        '',
        'class Services:',
        '    def __init__(self, ledger: Any):',
        '        self.ledger = ledger',
        '',
        'def consume(services: Services):',
        '    services.ledger.record()',
        '',
        'def entry():',
        '    engine = Engine()',
        '    services = Services(engine.ledger)',
        '    consume(services=services)',
      ].join('\n'),
    },
    file: 'app.py', line: 15, token: 'record', expected: 'app.py:Ledger.record',
  },
  {
    id: 'override-dispatch',
    files: {
      'app.py': [
        'class Base:',
        '    def run(self): pass',
        '',
        'class Child(Base):',
        '    def run(self): pass',
        '',
        'def go():',
        '    child = Child()',
        '    child.run()',
      ].join('\n'),
    },
    file: 'app.py', line: 9, token: 'run', expected: 'app.py:Child.run',
  },
  {
    id: 'branch-conflicted-reassignment',
    files: {
      'app.py': [
        'class A:',
        '    def run(self): pass',
        'class B:',
        '    def run(self): pass',
        '',
        'def go(flag):',
        '    value = A()',
        '    if flag:',
        '        value = B()',
        '    value.run()',
      ].join('\n'),
    },
    file: 'app.py', line: 10, token: 'run', expected: 'abstain',
  },
  {
    id: 'typed-parameter-alias',
    files: {
      'models.py': 'class Service:\n    def run(self): pass\n',
      'app.py': 'from models import Service\n\ndef use(service: Service):\n    alias = service\n    alias.run()\n',
    },
    file: 'app.py', line: 5, token: 'run', expected: 'models.py:Service.run',
  },
  {
    id: 'callable-object',
    files: {
      'app.py': [
        'class Handler:',
        '    def __call__(self): pass',
        '',
        'def go():',
        '    handler = Handler()',
        '    handler()',
      ].join('\n'),
    },
    file: 'app.py', line: 6, token: 'handler', expected: 'app.py:Handler.__call__',
  },
  {
    id: 'protocol-static-dispatch',
    files: {
      'app.py': [
        'from typing import Protocol',
        '',
        'class Runner(Protocol):',
        '    def run(self): ...',
        '',
        'class Impl:',
        '    def run(self): pass',
        '',
        'def use(value: Runner):',
        '    value.run()',
      ].join('\n'),
    },
    file: 'app.py', line: 10, token: 'run', expected: 'static:Runner.run',
  },
  {
    id: 'decorator-replacement',
    files: {
      'app.py': [
        'def replacement(): pass',
        '',
        'def replace(fn):',
        '    return replacement',
        '',
        '@replace',
        'def original(): pass',
        '',
        'def go():',
        '    original()',
      ].join('\n'),
    },
    file: 'app.py', line: 10, token: 'original', expected: 'runtime:replacement',
  },
];

await rm(root, { recursive: true, force: true });
await mkdir(root, { recursive: true });

for (const c of cases) {
  const dir = path.join(root, c.id);
  await mkdir(dir, { recursive: true });
  for (const [name, content] of Object.entries(c.files)) {
    await writeFile(path.join(dir, name), content + (content.endsWith('\n') ? '' : '\n'));
  }
}

class LspClient {
  constructor(child) {
    this.child = child;
    this.nextId = 1;
    this.pending = new Map();
    this.buffer = Buffer.alloc(0);
    child.stdout.on('data', (chunk) => this.onData(chunk));
    child.stderr.on('data', () => {});
  }

  onData(chunk) {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    while (true) {
      const marker = this.buffer.indexOf('\r\n\r\n');
      if (marker < 0) return;
      const header = this.buffer.subarray(0, marker).toString('utf8');
      const match = /Content-Length:\s*(\d+)/i.exec(header);
      if (!match) throw new Error(`invalid LSP header: ${header}`);
      const length = Number(match[1]);
      const bodyStart = marker + 4;
      if (this.buffer.length < bodyStart + length) return;
      const body = this.buffer.subarray(bodyStart, bodyStart + length).toString('utf8');
      this.buffer = this.buffer.subarray(bodyStart + length);
      const message = JSON.parse(body);
      if (message.id !== undefined && this.pending.has(message.id)) {
        const { resolve, reject } = this.pending.get(message.id);
        this.pending.delete(message.id);
        if (message.error) reject(new Error(JSON.stringify(message.error)));
        else resolve(message.result);
      }
    }
  }

  send(message) {
    const payload = JSON.stringify(message);
    this.child.stdin.write(`Content-Length: ${Buffer.byteLength(payload)}\r\n\r\n${payload}`);
  }

  request(method, params) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.send({ jsonrpc: '2.0', id, method, params });
    });
  }

  notify(method, params) {
    this.send({ jsonrpc: '2.0', method, params });
  }
}

const child = spawn(
  'env',
  [
    `PYTHONPATH=${pyrightSite}`,
    '/usr/bin/python3',
    '-m',
    'pyright.langserver',
    '--stdio',
  ],
  { cwd: root, stdio: ['pipe', 'pipe', 'pipe'] },
);
const client = new LspClient(child);
const rootUri = pathToFileURL(root).href;
const initialized = await client.request('initialize', {
  processId: process.pid,
  rootUri,
  capabilities: {
    textDocument: {
      definition: { linkSupport: true },
    },
  },
  workspaceFolders: [{ uri: rootUri, name: 'python-p1' }],
});
client.notify('initialized', {});

function positionFor(content, oneBasedLine, token) {
  const line = content.split('\n')[oneBasedLine - 1] ?? '';
  const character = line.indexOf(token);
  if (character < 0) throw new Error(`token ${token} not found on line ${oneBasedLine}: ${line}`);
  return { line: oneBasedLine - 1, character };
}

function normalizeLocations(result) {
  if (!result) return [];
  const values = Array.isArray(result) ? result : [result];
  return values.map((entry) => {
    if (entry.targetUri) {
      return {
        uri: entry.targetUri,
        line: entry.targetSelectionRange?.start?.line ?? entry.targetRange?.start?.line ?? -1,
        startCharacter: entry.targetSelectionRange?.start?.character ?? entry.targetRange?.start?.character ?? 0,
        endCharacter: entry.targetSelectionRange?.end?.character ?? entry.targetRange?.end?.character ?? 0,
      };
    }
    return {
      uri: entry.uri,
      line: entry.range?.start?.line ?? -1,
      startCharacter: entry.range?.start?.character ?? 0,
      endCharacter: entry.range?.end?.character ?? 0,
    };
  }).filter((entry) => entry.uri);
}

function symbolAt(files, file, zeroLine) {
  const lines = files[file]?.split('\n') ?? [];
  const line = lines[zeroLine]?.trim() ?? '';
  const method = /^def\s+([A-Za-z_][A-Za-z0-9_]*)/.exec(line)?.[1];
  if (method) {
    for (let i = zeroLine - 1; i >= 0; i -= 1) {
      const className = /^class\s+([A-Za-z_][A-Za-z0-9_]*)/.exec(lines[i]?.trim() ?? '')?.[1];
      if (className && /^\s+/.test(lines[zeroLine] ?? '')) return `${className}.${method}`;
      if (lines[i] && !/^\s/.test(lines[i])) break;
    }
    return method;
  }
  const cls = /^class\s+([A-Za-z_][A-Za-z0-9_]*)/.exec(line)?.[1];
  return cls ?? line;
}

const rows = [];
for (const c of cases) {
  const dir = path.join(root, c.id);
  const filePath = path.join(dir, c.file);
  const content = c.files[c.file];
  const uri = pathToFileURL(filePath).href;
  client.notify('textDocument/didOpen', {
    textDocument: {
      uri,
      languageId: 'python',
      version: 1,
      text: content,
    },
  });
  const result = await client.request('textDocument/definition', {
    textDocument: { uri },
    position: positionFor(content, c.line, c.token),
  });
  const locations = normalizeLocations(result);
  const targets = locations.map((loc) => {
    const targetPath = fileURLToPath(loc.uri);
    const relative = path.relative(dir, targetPath).replaceAll('\\', '/');
    const source = c.files[relative];
    const sourceLine = source?.split('\n')[loc.line] ?? '';
    const selection = sourceLine.slice(loc.startCharacter, loc.endCharacter);
    const symbol = source ? symbolAt(c.files, relative, loc.line) : `line:${loc.line + 1}`;
    return `${relative}:${symbol} [${selection || '?'}]`;
  });
  rows.push({
    id: c.id,
    expected: c.expected,
    definitions: [...new Set(targets)].sort(),
  });
  client.notify('textDocument/didClose', { textDocument: { uri } });
}

client.notify('shutdown', undefined);
child.kill();

process.stdout.write(JSON.stringify({
  provider: 'pyright',
  version: '1.1.408',
  capability: initialized?.capabilities?.definitionProvider ?? null,
  root,
  rows,
}, null, 2) + '\n');
