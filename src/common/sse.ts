import type { Logger } from '@nestjs/common';
import type { Response } from 'express';

export interface SseEvent {
  event: string;
  data: unknown;
}

/**
 * Streams events as Server-Sent Events over the current response. Aborts the
 * producer when the client disconnects; failures become an `error` event.
 * Validation must happen before calling this, while errors can still be JSON.
 */
export async function streamSse(
  res: Response,
  produce: (signal: AbortSignal) => AsyncIterable<SseEvent>,
  logger: Logger,
): Promise<void> {
  res.status(200).set({
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.flushHeaders();

  const abort = new AbortController();
  res.on('close', () => {
    if (!res.writableFinished) abort.abort();
  });
  const send = (event: string, data: unknown) =>
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);

  try {
    for await (const ev of produce(abort.signal)) send(ev.event, ev.data);
  } catch (err) {
    if (!abort.signal.aborted) {
      const status = (err as { status?: number }).status;
      // HttpExceptions raised mid-stream (e.g. 409) carry a safe message.
      const message =
        status && status < 500
          ? (err as Error).message
          : 'The assistant failed to respond. Try again.';
      logger.error(`Stream failed: ${(err as Error).stack ?? String(err)}`);
      send('error', { message });
    }
  } finally {
    res.end();
  }
}
