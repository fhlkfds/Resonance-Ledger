import { Writable } from 'node:stream';
import pino from 'pino';
import { describe, expect, it } from 'vitest';

describe('log redaction contract', () => {
  it('recursively redacts configured secret fields', () => {
    let output = '';
    const sink = new Writable({
      write(chunk, _encoding, callback) {
        output += chunk.toString();
        callback();
      },
    });
    const log = pino(
      {
        redact: {
          paths: ['*.accessToken', '*.authorization', 'password'],
          censor: '[REDACTED]',
        },
      },
      sink,
    );
    log.info(
      {
        provider: {
          accessToken: 'recognizable-token',
          authorization: 'Bearer secret',
        },
        password: 'database-secret',
      },
      'safe event',
    );
    expect(output).not.toContain('recognizable-token');
    expect(output).not.toContain('Bearer secret');
    expect(output).not.toContain('database-secret');
    expect(output).toContain('[REDACTED]');
  });
});
