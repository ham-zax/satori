import assert from 'node:assert/strict';
import test from 'node:test';

import type * as ts from '../semantic/typescript-api';

import { createFlowRecoveryParser, type FlowRecoveryApi } from './flow-recovery';

const emptySourceFile = { forEachChild: (): void => {} } as unknown as ts.SourceFile;

class FakeApi implements FlowRecoveryApi {
    readonly created: string[] = [];
    disposed = 0;
    closed = 0;
    failCreate = false;

    createSourceFile(fileName: string): { readonly sourceFile: ts.SourceFile; dispose(): void } {
        if (this.failCreate) throw new Error('transport closed');
        this.created.push(fileName);
        return {
            sourceFile: emptySourceFile,
            dispose: () => { this.disposed += 1; },
        };
    }

    close(): void {
        this.closed += 1;
    }
}

function collectingFactory(): { readonly clients: FakeApi[]; readonly createApi: () => FakeApi } {
    const clients: FakeApi[] = [];
    return {
        clients,
        createApi: () => {
            const client = new FakeApi();
            clients.push(client);
            return client;
        },
    };
}

test('Flow recovery reuses one API and disposes each source-file lease', () => {
    const { clients, createApi } = collectingFactory();
    const parser = createFlowRecoveryParser({ createApi });
    try {
        assert.equal(clients.length, 0, 'the API is created lazily');
        assert.deepEqual(parser.recover('let first = 1;', 'first.js'), []);
        assert.deepEqual(parser.recover('let second = 2;', 'second.js'), []);
        assert.equal(clients.length, 1);
        assert.deepEqual(clients[0]?.created, ['first.js', 'second.js']);
        assert.equal(clients[0]?.disposed, 2);
    } finally {
        parser.close();
    }
});

test('Flow recovery close is idempotent and the next recover creates a new API', () => {
    const { clients, createApi } = collectingFactory();
    const parser = createFlowRecoveryParser({ createApi });
    parser.recover('let first = 1;', 'first.js');
    parser.close();
    parser.close();
    assert.equal(clients.length, 1);
    assert.equal(clients[0]?.closed, 1);
    assert.deepEqual(parser.recover('let second = 2;', 'second.js'), []);
    assert.equal(clients.length, 2);
    assert.deepEqual(clients[1]?.created, ['second.js']);
    parser.close();
    assert.equal(clients[1]?.closed, 1);
});

test('an idle Flow parser closes its API after 30 seconds and recreates it on demand', (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const { clients, createApi } = collectingFactory();
    const parser = createFlowRecoveryParser({ createApi });
    parser.recover('let first = 1;', 'first.js');
    t.mock.timers.tick(29_999);
    assert.equal(clients[0]?.closed, 0);
    t.mock.timers.tick(1);
    assert.equal(clients[0]?.closed, 1);
    parser.recover('let second = 2;', 'second.js');
    assert.equal(clients.length, 2);
    parser.close();
});

test('a transport failure closes the API and the next recover starts a new one', () => {
    const clients: FakeApi[] = [];
    const parser = createFlowRecoveryParser({
        createApi: () => {
            const client = new FakeApi();
            client.failCreate = clients.length === 0;
            clients.push(client);
            return client;
        },
    });
    assert.throws(() => parser.recover('let first = 1;', 'first.js'), /transport closed/);
    assert.equal(clients.length, 1);
    assert.equal(clients[0]?.closed, 1);
    assert.deepEqual(parser.recover('let second = 2;', 'second.js'), []);
    assert.equal(clients.length, 2);
    assert.deepEqual(clients[1]?.created, ['second.js']);
    parser.close();
});
