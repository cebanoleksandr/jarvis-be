import {
  parseArguments,
  readSse,
  toOpenAiMessages,
  toStopReason,
} from './openrouter.provider.js';

describe('toOpenAiMessages', () => {
  it('translates a tool round trip and drops provider-only blocks', () => {
    const messages = toOpenAiMessages('SYS', [
      { role: 'user', content: [{ type: 'text', text: 'What is today?' }] },
      {
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: '', signature: 's' },
          { type: 'text', text: 'Let me check.' },
          { type: 'tool_use', id: 't1', name: 'get_events', input: { d: 1 } },
          { type: 'tool_use', id: 't2', name: 'list_tasks', input: {} },
        ],
      },
      {
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: 't1', content: '{"events":[]}' },
          {
            type: 'tool_result',
            tool_use_id: 't2',
            content: 'Service is down',
            is_error: true,
          },
          { type: 'text', text: 'and tomorrow?' },
        ],
      },
    ]);
    expect(messages).toEqual([
      { role: 'system', content: 'SYS' },
      { role: 'user', content: 'What is today?' },
      {
        role: 'assistant',
        content: 'Let me check.',
        tool_calls: [
          {
            id: 't1',
            type: 'function',
            function: { name: 'get_events', arguments: '{"d":1}' },
          },
          {
            id: 't2',
            type: 'function',
            function: { name: 'list_tasks', arguments: '{}' },
          },
        ],
      },
      { role: 'tool', tool_call_id: 't1', content: '{"events":[]}' },
      { role: 'tool', tool_call_id: 't2', content: 'Error: Service is down' },
      { role: 'user', content: 'and tomorrow?' },
    ]);
  });

  it('skips assistant turns that have nothing to send', () => {
    expect(
      toOpenAiMessages('S', [
        { role: 'assistant', content: [{ type: 'thinking', thinking: '' }] },
      ]),
    ).toEqual([{ role: 'system', content: 'S' }]);
  });
});

describe('readSse', () => {
  const stream = async function* (...parts: string[]) {
    for (const p of parts) yield new TextEncoder().encode(p);
  };
  const collect = async (...parts: string[]) => {
    const out: unknown[] = [];
    for await (const c of readSse(stream(...parts))) out.push(c);
    return out;
  };

  it('joins chunks split mid-line and ignores comments and [DONE]', async () => {
    expect(
      await collect(
        ': OPENROUTER PROCESSING\n\ndata: {"mo',
        'del":"a"}\n\ndata: {"model":"приве',
        'т"}\r\n\r\ndata: [DONE]\n\n',
      ),
    ).toEqual([{ model: 'a' }, { model: 'привет' }]);
  });

  it('reads a last line without a trailing newline', async () => {
    expect(await collect('data: {"model":"x"}')).toEqual([{ model: 'x' }]);
  });
});

describe('parseArguments and toStopReason', () => {
  it('parses JSON, treats empty as no arguments, keeps garbage visible', () => {
    expect(parseArguments('{"a":1}')).toEqual({ a: 1 });
    expect(parseArguments('')).toEqual({});
    expect(parseArguments('{"a":')).toEqual({ _unparsed: '{"a":' });
  });

  it('maps finish reasons to the canonical stop reasons', () => {
    expect(toStopReason('stop', false)).toBe('end_turn');
    expect(toStopReason('stop', true)).toBe('tool_use');
    expect(toStopReason('tool_calls', true)).toBe('tool_use');
    expect(toStopReason('tool_calls', false)).toBe('end_turn');
    expect(toStopReason('length', false)).toBe('max_tokens');
    expect(toStopReason('content_filter', false)).toBe('refusal');
  });
});
