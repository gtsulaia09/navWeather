import { RoadEngineError, type RoadEngineErrorCode } from './errors';
import type { EngineRequest, RoadEngine, RoadSource } from './engine';
import type { RoadsIndex } from './format';
import type { OsrmLikeRoute } from './guidance';

/**
 * The app's handle on the device router (ADR-019). In the browser the engine runs in a Web Worker so planning never
 * freezes the screen; where workers don't exist (tests, old browsers) it runs in place.
 */
export interface RoadClient {
  route(req: EngineRequest, signal?: AbortSignal): Promise<OsrmLikeRoute[]>;
}

/** Road files over HTTP: the small index is always re-checked, build folders are immutable and cached. */
export function fetchSource(base: string): RoadSource {
  const root = base.replace(/\/$/, '');
  return {
    async index(): Promise<RoadsIndex> {
      const res = await fetch(`${root}/roads.json`, { cache: 'no-cache' });
      const ct = res.headers.get('content-type') ?? '';
      if (res.status === 404 || (res.ok && ct.includes('text/html'))) {
        throw new RoadEngineError('roads.json not built yet', 'data-missing');
      }
      if (!res.ok) throw new Error(`roads.json: HTTP ${res.status}`);
      return (await res.json()) as RoadsIndex;
    },
    async bytes(build: string, path: string): Promise<Uint8Array> {
      const res = await fetch(`${root}/roads/${build}/${path}`);
      if (!res.ok) throw new Error(`${path}: HTTP ${res.status}`);
      return new Uint8Array(await res.arrayBuffer());
    },
  };
}

function abortError(): DOMException {
  return new DOMException('Aborted', 'AbortError');
}

/** The engine in this thread (loaded lazily so browsers with Web Workers don't bundle a second copy). */
export class InlineRoadClient implements RoadClient {
  private enginePromise: Promise<RoadEngine> | null = null;
  constructor(private readonly source: RoadSource) {}
  async route(req: EngineRequest, signal?: AbortSignal): Promise<OsrmLikeRoute[]> {
    if (signal?.aborted) throw abortError();
    this.enginePromise ??= import('./engine').then((m) => new m.RoadEngine(this.source));
    const engine = await this.enginePromise;
    if (signal?.aborted) throw abortError();
    const out = await engine.route(req);
    if (signal?.aborted) throw abortError();
    return out;
  }
}

/** Messages between the app and the routing worker. */
export type WorkerRequest = { id: number; base: string; req: EngineRequest };
export type WorkerResponse = { id: number; routes: OsrmLikeRoute[] } | { id: number; error: { message: string; code: RoadEngineErrorCode | null } };

/** The engine in a Web Worker (one per app; requests are answered in turn). */
export class WorkerRoadClient implements RoadClient {
  private worker: Worker | null = null;
  private next = 1;
  private pending = new Map<number, { resolve: (r: OsrmLikeRoute[]) => void; reject: (e: unknown) => void }>();
  private readonly base: string;
  private readonly fallback: InlineRoadClient;

  constructor(base: string) {
    this.base = base;
    this.fallback = new InlineRoadClient(fetchSource(base));
  }

  private start(): Worker | null {
    if (this.worker) return this.worker;
    try {
      this.worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });
    } catch {
      return null;
    }
    this.worker.onmessage = (ev: MessageEvent<WorkerResponse>) => {
      const p = this.pending.get(ev.data.id);
      if (!p) return; // aborted meanwhile
      this.pending.delete(ev.data.id);
      if ('routes' in ev.data) p.resolve(ev.data.routes);
      else p.reject(ev.data.error.code ? new RoadEngineError(ev.data.error.message, ev.data.error.code) : new Error(ev.data.error.message));
    };
    this.worker.onerror = () => {
      // A worker that can't start (blocked script, old browser): route in place from now on.
      for (const p of this.pending.values()) p.reject(new RoadEngineError('Routing worker failed', 'data-unavailable'));
      this.pending.clear();
      this.worker?.terminate();
      this.worker = null;
      this.broken = true;
    };
    return this.worker;
  }
  private broken = false;

  route(req: EngineRequest, signal?: AbortSignal): Promise<OsrmLikeRoute[]> {
    if (signal?.aborted) return Promise.reject(abortError());
    const worker = this.broken ? null : this.start();
    if (!worker) return this.fallback.route(req, signal);
    const id = this.next++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      signal?.addEventListener(
        'abort',
        () => {
          if (this.pending.delete(id)) reject(abortError());
        },
        { once: true },
      );
      const msg: WorkerRequest = { id, base: this.base, req };
      worker.postMessage(msg);
    });
  }
}

/** The best client for this environment. */
export function createRoadClient(base: string): RoadClient {
  return typeof Worker !== 'undefined' && typeof window !== 'undefined' ? new WorkerRoadClient(base) : new InlineRoadClient(fetchSource(base));
}
