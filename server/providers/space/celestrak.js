import {
  createCelestrakClient,
  celestrakResponse,
} from './celestrak-client.js';

/** Application middleware and public E2E use the same durable request policy. */
export function celestrakProxy({ client = createCelestrakClient() } = {}) {
  const installMiddleware = (server) => {
    server.middlewares.use('/api/celestrak', async (req, res) => {
      const group = String(req.url || '')
        .replace(/^\//, '')
        .split('?')[0];
      if (!/^[a-z0-9-]{1,64}$/i.test(group)) {
        res.writeHead(400, { 'Content-Type': 'text/plain' });
        res.end('invalid group');
        return;
      }
      if (req.method && req.method !== 'GET') {
        res.writeHead(405, { Allow: 'GET' });
        res.end('method not allowed');
        return;
      }
      try {
        const result = await client.readGroup(group);
        if (result.diagnostic)
          console.warn('[celestrak-proxy]', JSON.stringify(result.diagnostic));
        const response = celestrakResponse(result);
        res.writeHead(response.status, Object.fromEntries(response.headers));
        res.end(await response.text());
      } catch {
        console.error('[celestrak-proxy] request failed');
        if (!res.headersSent) {
          res.writeHead(500, {
            'Content-Type': 'text/plain',
            'Cache-Control': 'no-store',
            'x-tle-cache': 'ERROR',
          });
          res.end('celestrak proxy error');
        }
      }
    });
  };
  return {
    name: 'celestrak-proxy',
    configureServer: installMiddleware,
    configurePreviewServer: installMiddleware,
  };
}
