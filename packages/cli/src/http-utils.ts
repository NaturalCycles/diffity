import type { IncomingMessage, ServerResponse } from 'node:http';
import type { ParseResult } from '@diffity/api';

export function sendJson(res: ServerResponse, data: unknown) {
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

export function sendError(res: ServerResponse, status: number, message: string) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: message }));
}

export function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks).toString()));
    req.on('error', reject);
  });
}

/**
 * Reads, parses and validates a request body, then hands the typed value to the handler. What the
 * sender got wrong is a 400 with the field named; anything else that throws is a 500.
 */
export function withJsonBody<T>(
  res: ServerResponse,
  req: IncomingMessage,
  errorPrefix: string,
  parseBody: (body: unknown) => ParseResult<T>,
  handler: (body: T) => void | Promise<void>,
) {
  void (async () => {
    let raw: string;
    try {
      raw = await readBody(req);
    } catch (err) {
      sendError(res, 500, `${errorPrefix}: ${err}`);
      return;
    }
    let body: unknown;
    try {
      body = JSON.parse(raw);
    } catch {
      sendError(res, 400, 'Request body must be valid JSON');
      return;
    }
    try {
      const parsed = parseBody(body);
      if (!parsed.ok) {
        sendError(res, 400, parsed.error);
        return;
      }
      await handler(parsed.value);
    } catch (err) {
      // The handler may have answered before it threw; a second write would itself throw, and
      // out of here nothing catches it.
      if (!res.headersSent) {
        sendError(res, 500, `${errorPrefix}: ${err}`);
      }
    }
  })();
}
