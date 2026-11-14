import { afterEach, describe, expect, it, vi } from 'vitest';
import { guardedFetch } from './cloudSyncService';

function respond(status: number, contentType: string, body = '') {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response(body, { status, headers: { 'content-type': contentType } })),
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('guardedFetch', () => {
  it('passes Supabase answers through, errors included', async () => {
    respond(200, 'application/json', '[]');
    expect((await guardedFetch('https://x/rest/v1/t')).status).toBe(200);
    respond(400, 'application/json; charset=utf-8', '{"code":"invalid_credentials"}');
    expect((await guardedFetch('https://x/auth/v1/token')).status).toBe(400);
  });

  it('turns a non-JSON error page into a network failure, so the session is kept', async () => {
    // A Vercel 404, a captive portal or a block page is not an answer from Supabase.
    respond(404, 'text/plain', 'The deployment could not be found on Vercel.');
    await expect(guardedFetch('https://x/auth/v1/token')).rejects.toBeInstanceOf(TypeError);
    respond(403, 'text/html', '<html>blocked</html>');
    await expect(guardedFetch('https://x/auth/v1/token')).rejects.toThrow(/Failed to fetch/);
  });
});
