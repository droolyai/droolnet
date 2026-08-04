import { describe, expect, test } from 'vitest';
import { rankFeed, type FeedItem, type FeedPreferences } from '../src/index.js';

const items: readonly FeedItem[] = [
  { objectId: 'obj:alpha:001', authorId: 'author:alex', createdAt: '2026-08-04T11:00:00.000Z', topics: ['music'], contentLabel: 'explicit-music', evidenceScore: 900 },
  { objectId: 'obj:alpha:002', authorId: 'author:alex', createdAt: '2026-08-04T11:30:00.000Z', topics: ['music'], contentLabel: 'sfw', evidenceScore: 850 },
  { objectId: 'obj:beta:001', authorId: 'author:beta', createdAt: '2026-08-04T10:00:00.000Z', topics: ['protocol'], contentLabel: 'sfw', evidenceScore: 950 },
  { objectId: 'obj:adult:001', authorId: 'author:adult', createdAt: '2026-08-04T11:59:00.000Z', topics: ['culture'], contentLabel: 'adult-nsfw', evidenceScore: 1000 },
];

const preferences: FeedPreferences = {
  followedAuthors: ['author:alex'],
  blockedAuthors: [],
  mutedObjectIds: [],
  visibleLabels: ['sfw', 'explicit-music'],
  topicAffinity: { music: 500, protocol: 200 },
  weights: { recency: 500, relationship: 900, evidence: 700, discovery: 250 },
  maximumConsecutiveAuthorItems: 1,
};

describe('transparent decentralized feed', () => {
  test('is deterministic, receipt-producing, and independent of input order', () => {
    const left = rankFeed(items, preferences, { asOf: '2026-08-04T12:00:00.000Z' });
    const right = rankFeed([...items].reverse(), preferences, { asOf: '2026-08-04T12:00:00.000Z' });
    expect(left).toEqual(right);
    expect(left.receipt.policy).toBe('wokenet.feed.transparent.v1');
    expect(left.receipt.inputHash).toMatch(/^u[A-Za-z0-9_-]{43}$/u);
    expect(left.receipt.outputHash).toMatch(/^u[A-Za-z0-9_-]{43}$/u);
  });

  test('hides adult content by local policy and enforces author diversity', () => {
    const result = rankFeed(items, preferences, { asOf: '2026-08-04T12:00:00.000Z' });
    expect(result.items.map((item) => item.objectId)).not.toContain('obj:adult:001');
    expect(result.receipt.excludedCount).toBe(1);
    expect(result.items[0]?.authorId).not.toBe(result.items[1]?.authorId);
  });

  test('blocks and mutes before scoring', () => {
    const result = rankFeed(items, { ...preferences, blockedAuthors: ['author:alex'], mutedObjectIds: ['obj:beta:001'] }, { asOf: '2026-08-04T12:00:00.000Z' });
    expect(result.items).toEqual([]);
    expect(result.receipt.excludedCount).toBe(4);
  });

  test('rejects secret popularity and paid-boost extension fields', () => {
    const polluted = { ...(items[0] as FeedItem), likes: 10_000, paidBoost: 1 } as FeedItem;
    expect(() => rankFeed([polluted], preferences, { asOf: '2026-08-04T12:00:00.000Z' })).toThrow(/unsupported fields/u);
  });
});
