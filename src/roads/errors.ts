/** Why routing failed, so the app can say it plainly (kept separate from `engine.ts` so the main bundle stays small). */
export type RoadEngineErrorCode = 'not-covered' | 'no-road-nearby' | 'no-route' | 'data-missing' | 'data-unavailable';

export class RoadEngineError extends Error {
  readonly code: RoadEngineErrorCode;
  constructor(message: string, code: RoadEngineErrorCode) {
    super(message);
    this.name = 'RoadEngineError';
    this.code = code;
  }
}
