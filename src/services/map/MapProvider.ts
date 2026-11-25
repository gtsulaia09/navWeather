import { createPackProtocol } from '../../map/packProtocol';

export type MapTheme = 'light' | 'dark';

/** Basemap source. Swap for a commercial provider without touching the map UI. */
export interface MapProvider {
  readonly name: string;
  getStyleUrl(theme: MapTheme, lang?: string): string;
  /** A custom URL scheme the map must register before loading the style (MapLibre `addProtocol`). */
  readonly protocol?: { name: string; load: (params: { url: string; type?: string }, ctrl: AbortController) => Promise<{ data: unknown }> };
}

/**
 * OUR basemap from static files (ADR-020, REQ-MAP-003): styles, tile packs, fonts and sprites under one base URL,
 * read through the `navpack://` protocol; the fallback style (OpenFreeMap) answers while none is deployed.
 */
export class PackMapProvider implements MapProvider {
  readonly name = 'packs';
  readonly protocol: NonNullable<MapProvider['protocol']>;

  constructor(
    baseUrl: string,
    private lang: string,
    fallback: { light: string; dark: string },
  ) {
    this.protocol = { name: 'navpack', load: createPackProtocol({ baseUrl, fallbackStyle: (t) => fallback[t] }) };
  }

  getStyleUrl(theme: MapTheme, lang?: string): string {
    return `navpack://style/${theme}/${lang ?? this.lang}`;
  }
}

export class StyleUrlMapProvider implements MapProvider {
  constructor(
    readonly name: string,
    private light: string,
    private dark: string,
  ) {}

  getStyleUrl(theme: MapTheme, _lang?: string): string {
    return theme === 'dark' ? this.dark : this.light;
  }
}
