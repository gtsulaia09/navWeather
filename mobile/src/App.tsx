/**
 * ADR-010 React Native prototype screen.
 *
 * Demonstrates one shared TypeScript codebase serving iOS (iPhone/iPad), Android (phones/tablets/foldables),
 * CarPlay, Android Auto, Apple Watch, and Wear OS — importing our exact engines from `../../src/*` with zero
 * React DOM or browser APIs, and wiring the native seams in `../../src/platform/*`.
 */
import { useEffect, useState } from 'react';
import { runHermesCorePipeline } from './hermes-core-entry';

export type MobilePreviewState = Awaited<ReturnType<typeof runHermesCorePipeline>> | null;

/**
 * Platform-neutral React Native hook: runs the shared navWeather core in Hermes and returns the route weather
 * timeline, alerts, and CarPlay/Android Auto/Watch snapshot ready for React Native Views or native car templates.
 */
export function useNavWeatherMobileCore(): MobilePreviewState {
  const [data, setData] = useState<MobilePreviewState>(null);
  useEffect(() => {
    let alive = true;
    void runHermesCorePipeline().then((res) => {
      if (alive) setData(res);
    });
    return () => {
      alive = false;
    };
  }, []);
  return data;
}
