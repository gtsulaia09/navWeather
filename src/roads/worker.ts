/// <reference lib="webworker" />
import { RoadEngine, RoadEngineError } from './engine';
import { fetchSource, type WorkerRequest, type WorkerResponse } from './client';

/** The routing Web Worker: one engine (and its file and graph caches) for the life of the app. */
const engines = new Map<string, RoadEngine>();

self.onmessage = async (ev: MessageEvent<WorkerRequest>) => {
  const { id, base, req } = ev.data;
  let engine = engines.get(base);
  if (!engine) engines.set(base, (engine = new RoadEngine(fetchSource(base))));
  let msg: WorkerResponse;
  try {
    msg = { id, routes: await engine.route(req) };
  } catch (e) {
    msg = { id, error: { message: e instanceof Error ? e.message : String(e), code: e instanceof RoadEngineError ? e.code : null } };
  }
  (self as unknown as DedicatedWorkerGlobalScope).postMessage(msg);
};
