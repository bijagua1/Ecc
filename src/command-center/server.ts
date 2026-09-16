import { AIGatewayHealthService } from '../../src/services/ai-gateway-health.js';

const PORT = Number(process.env.ECC_COMMAND_CENTER_PORT ?? 38000);
const GATEWAY_URL = process.env.ECC_GATEWAY_URL ?? 'http://127.0.0.1:37778';
const ECC_SERVER_URL = process.env.ECC_SERVER_URL ?? 'http://127.0.0.1:37877';
const ECC_API_KEY = process.env.ECC_API_KEY ?? '';

const agents = [
  { name: 'Kimi', role: 'Primary coding agent' },
  { name: 'Claude', role: 'Coding / reasoning agent' },
  { name: 'Codex', role: 'Coding agent' },
  { name: 'Gemini', role: 'Reasoning / multimodal agent' },
];

const publicDir = new URL('./public/', import.meta.url);

async function gatewayHealth() {
  try {
    const service = new AIGatewayHealthService(GATEWAY_URL, 3000);
    return await service.checkHealth();
  } catch (error) {
    return {
      status: 'unavailable',
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

const server = Bun.serve({
  hostname: '127.0.0.1',
  port: PORT,

  async fetch(req) {
    const url = new URL(req.url);

    if (url.pathname === '/api/status') {
      const gateway = await gatewayHealth();

      return Response.json({
        ok: gateway.status === 'ok' || gateway.status === 'healthy',
        gateway,
        agents: agents.map(agent => ({
          ...agent,
          status: 'available',
          health: 'unverified',
        })),
        timestamp: new Date().toISOString(),
      });
    }

    if (url.pathname === '/gateway-health') {
      return Response.json(await gatewayHealth());
    }

    if (url.pathname === '/agents') {
      return Response.json(
        agents.map(agent => ({
          ...agent,
          status: 'available',
          health: 'unverified',
        })),
      );
    }

    if (url.pathname === '/api/jobs') {
      try {
        const headers: Record<string, string> = {};
        if (ECC_API_KEY) headers['X-Api-Key'] = ECC_API_KEY;

        const response = await fetch(
          `${ECC_SERVER_URL}/v1/jobs?limit=25`,
          { headers, signal: AbortSignal.timeout(5000) },
        );

        const body = await response.json().catch(() => ({}));

        return Response.json(
          {
            ...body,
            available: response.ok,
            backend: ECC_SERVER_URL,
          },
          { status: response.ok ? 200 : response.status },
        );
      } catch (error) {
        return Response.json({
          jobs: [],
          total: 0,
          available: false,
          backend: ECC_SERVER_URL,
          message: error instanceof Error ? error.message : String(error),
        });
      }
    }

    if (url.pathname === '/api/activity') {
      try {
        const headers: Record<string, string> = {};
        if (ECC_API_KEY) headers['X-Api-Key'] = ECC_API_KEY;

        const response = await fetch(
          `${ECC_SERVER_URL}/stream`,
          { headers, signal: AbortSignal.timeout(3000) },
        );

        return new Response(response.body, {
          status: response.status,
          headers: {
            'Content-Type': response.headers.get('content-type') ?? 'text/event-stream',
            'Cache-Control': 'no-cache',
            'Connection': 'keep-alive',
          },
        });
      } catch (error) {
        return Response.json({
          events: [],
          available: false,
          backend: ECC_SERVER_URL,
          message: error instanceof Error ? error.message : String(error),
        });
      }
    }

    if (url.pathname === '/' || url.pathname === '/index.html') {
      return new Response(
        await Bun.file(new URL('index.html', publicDir)).text(),
        { headers: { 'Content-Type': 'text/html; charset=utf-8' } },
      );
    }

    const file = Bun.file(new URL(url.pathname.slice(1), publicDir));

    if (await file.exists()) {
      return new Response(file);
    }

    return new Response('Not Found', { status: 404 });
  },
});

console.log(`ECC Command Center listening on http://127.0.0.1:${server.port}`);
