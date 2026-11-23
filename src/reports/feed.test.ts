import { describe, expect, it } from 'vitest';
import type { NostrEvent } from '../p2p/nostr';
import { cellOf, cellsForBoxes, mergeFeed, REPORT_EVENT_KIND, REPORT_EVENT_TAG, reportEventTemplate, splitByCell, voteEventTemplate } from './feed';
import type { PublicReport } from './protocol';

const NOW = Date.UTC(2026, 10, 21, 12);
let seq = 0;
/** mergeFeed trusts signatures (RelayPool verified them); ids only need their proof-of-work zero bits. */
function ev(t: { tags: string[][]; content: string; created_at?: number }, pubkey = 'a'.repeat(64), bits = 16): NostrEvent {
  const zeros = '0'.repeat(bits / 4);
  const id = (zeros + (++seq).toString(16).padStart(8, '0') + 'f'.repeat(64)).slice(0, 64);
  return { id, pubkey, created_at: t.created_at ?? Math.floor(NOW / 1000) - 60, kind: REPORT_EVENT_KIND, tags: [...t.tags, ['nonce', '1', String(bits)]], content: t.content, sig: 'f'.repeat(128) };
}
const report = (kind: 'accident' | 'hazard', lat: number, lon: number, pubkey?: string, agoS = 60) =>
  ev(reportEventTemplate(kind, lat, lon, NOW - agoS * 1000), pubkey);
const vote = (id: string, v: 'still' | 'gone', pubkey: string) => ev(voteEventTemplate(id, v, NOW - 30_000), pubkey);

describe('reports feed', () => {
  it('cells cover boxes and group reports', () => {
    expect(cellOf(41.7, 44.8)).toBe('41_44');
    expect(cellOf(-0.5, -0.5)).toBe('-1_-1');
    expect(cellsForBoxes([[44.5, 41.5, 45.2, 41.9]]).sort()).toEqual(['41_44', '41_45']);
    const g = splitByCell([{ id: 'x', kind: 'hazard', lat: 41.7, lon: 44.8, createdAt: 0, expiresAt: 1, confirms: 0, denies: 0 }]);
    expect([...g.keys()]).toEqual(['41_44']);
  });

  it('adds overflow reports, marks their source and keeps Worker reports', () => {
    const w: PublicReport = { id: 'W'.repeat(16), kind: 'roadworks', lat: 41.6, lon: 44.9, createdAt: NOW - 60_000, expiresAt: NOW + 3_600_000, confirms: 0, denies: 0 };
    const e = report('accident', 41.7, 44.8);
    const out = mergeFeed([w], [e], NOW);
    expect(out.map((r) => r.id).sort()).toEqual([e.id.slice(0, 16), w.id].sort());
    expect(out.find((r) => r.id === e.id.slice(0, 16))).toMatchObject({ kind: 'accident', src: 'n', expiresAt: NOW - 60_000 + 60 * 60_000 });
    expect(out.find((r) => r.id === w.id)?.src).toBeUndefined();
  });

  it('counts a second report nearby as a confirmation, never from the same key', () => {
    const first = report('hazard', 41.7, 44.8, 'b'.repeat(64), 120);
    const again = report('hazard', 41.7005, 44.8005, 'b'.repeat(64), 90);
    const other = report('hazard', 41.7005, 44.8005, 'c'.repeat(64), 60);
    const out = mergeFeed([], [first, again, other], NOW);
    expect(out).toHaveLength(1);
    expect(out[0].confirms).toBe(1);
  });

  it('applies votes: two "gone" from different keys end a report; the reporter cannot vote', () => {
    const r = report('accident', 41.7, 44.8, 'b'.repeat(64), 600);
    const id = r.id.slice(0, 16);
    expect(mergeFeed([], [r, vote(id, 'gone', 'b'.repeat(64))], NOW)).toHaveLength(1);
    expect(mergeFeed([], [r, vote(id, 'gone', 'c'.repeat(64)), vote(id, 'gone', 'c'.repeat(64))], NOW)).toHaveLength(1);
    expect(mergeFeed([], [r, vote(id, 'gone', 'c'.repeat(64)), vote(id, 'gone', 'd'.repeat(64))], NOW)).toHaveLength(0);
  });

  it('ignores weak proof of work, foreign tags, bad content and floods', () => {
    const weak = ev(reportEventTemplate('hazard', 41.7, 44.8, NOW), 'e'.repeat(64), 8);
    const foreign = ev({ tags: [['t', 'other']], content: JSON.stringify({ kind: 'hazard', lat: 1, lon: 1 }) });
    const junk = ev({ tags: [['t', REPORT_EVENT_TAG]], content: 'not json' });
    expect(mergeFeed([], [weak, foreign, junk], NOW)).toHaveLength(0);
    const flood = Array.from({ length: 40 }, (_, i) => report('hazard', 40 + i * 0.1, 44, 'f'.repeat(64)));
    expect(mergeFeed([], flood, NOW)).toHaveLength(30);
  });
});
