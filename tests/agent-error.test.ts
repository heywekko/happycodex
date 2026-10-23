import { describe, expect, test } from 'vitest';

import { summarizeAgentError } from '../src/agent-error.js';

describe('summarizeAgentError', () => {
  test('turns verbose TLS failures into a short recoverable notice', () => {
    expect(
      summarizeAgentError(
        'ERROR responses_websocket: failed to connect: tls handshake eof\n' +
          'at runCodexQuery (file:///tmp/dist/index.js:741:19)',
      ),
    ).toBe('Codex 网络连接失败，将有限重试；持续失败后保留消息并停止自动重试。');
  });

  test('bounds unknown error text to one short line', () => {
    const result = summarizeAgentError(`${'x'.repeat(700)}\nstack trace`);
    expect(result).toHaveLength(500);
    expect(result.endsWith('...')).toBe(true);
    expect(result).not.toContain('stack trace');
  });
});
