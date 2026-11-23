// LOCAL MOCK (not for commit). Answers the dev gateway with sample data so the
// native screens have something to show without a backend. Turn off with ?mock=0.

type Route = (request: {
  method: string;
  path: string;
  search: URLSearchParams;
  body: unknown;
}) => unknown | Promise<unknown>;

export type LoggedRequest = {
  method: string;
  path: string;
  operation?: string;
  served: 'mock' | 'pass';
  status?: number;
  body?: unknown;
};

const GATEWAY = '/__macro_dev/gateway';
const log: LoggedRequest[] = [];
(globalThis as { __gw?: LoggedRequest[] }).__gw = log;

const routes = new Map<string, Route>();

/** Register a canned response for `METHOD /path` (path after the gateway prefix). */
export function route(key: string, handler: Route) {
  routes.set(key, handler);
}

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

async function readBody(init?: RequestInit, input?: Request) {
  const raw = init?.body ?? (input ? await input.clone().text() : undefined);
  if (typeof raw !== 'string' || raw === '') return undefined;
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

let ready: Promise<void> | undefined;
function loadRoutes() {
  ready ??= import('./routes').then(() => undefined);
  return ready;
}

/** Returns a mock Response for gateway calls we serve, otherwise undefined. */
export async function handle(
  input: RequestInfo | URL,
  init?: RequestInit
): Promise<Response | undefined> {
  const href =
    typeof input === 'string'
      ? input
      : input instanceof URL
        ? input.href
        : input.url;
  const url = new URL(href, location.origin);
  const at = url.pathname.indexOf(GATEWAY);
  if (at === -1 && !url.pathname.includes('/user/legacy_user_permissions'))
    return undefined;
  const path =
    at === -1 ? url.pathname : url.pathname.slice(at + GATEWAY.length);
  const method = (
    init?.method ?? (input instanceof Request ? input.method : 'GET')
  ).toUpperCase();
  await loadRoutes();
  const body = await readBody(
    init,
    input instanceof Request ? input : undefined
  );
  const operation =
    body && typeof body === 'object' && 'operationName' in body
      ? String((body as { operationName?: string }).operationName)
      : undefined;
  const entry: LoggedRequest = {
    method,
    path,
    operation,
    served: 'pass',
    body: operation ? undefined : body,
  };
  log.push(entry);
  const handler = routes.get(`${method} ${path}`);
  if (!handler) return undefined;
  entry.served = 'mock';
  try {
    const result = await handler({
      method,
      path,
      search: url.searchParams,
      body,
    });
    if (result instanceof Response) {
      entry.status = result.status;
      return result;
    }
    entry.status = 200;
    return json(result);
  } catch (error) {
    entry.status = 500;
    console.error('[dev-mock]', method, path, error);
    return json({ error: String(error) }, 500);
  }
}
