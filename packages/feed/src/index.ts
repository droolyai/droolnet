import { createHash } from 'node:crypto';

export const FEED_POLICY_ID = 'wokenet.feed.transparent.v1' as const;
export const FEED_VERSION = '0.1.0' as const;
export type ContentLabel = 'sfw' | 'explicit-music' | 'adult-nsfw';

export interface FeedItem {
  readonly objectId: string;
  readonly authorId: string;
  readonly createdAt: string;
  readonly topics: readonly string[];
  readonly contentLabel: ContentLabel;
  readonly evidenceScore: number;
}

export interface FeedPreferences {
  readonly followedAuthors: readonly string[];
  readonly blockedAuthors: readonly string[];
  readonly mutedObjectIds: readonly string[];
  readonly visibleLabels: readonly ContentLabel[];
  readonly topicAffinity: Readonly<Record<string, number>>;
  readonly weights: Readonly<{ recency: number; relationship: number; evidence: number; discovery: number }>;
  readonly maximumConsecutiveAuthorItems: number;
}

export interface RankedFeedItem {
  readonly objectId: string;
  readonly authorId: string;
  readonly score: number;
  readonly components: Readonly<{ recency: number; relationship: number; evidence: number; discovery: number; topic: number }>;
}

export interface RankedFeed {
  readonly items: readonly RankedFeedItem[];
  readonly receipt: Readonly<{
    policy: typeof FEED_POLICY_ID;
    version: typeof FEED_VERSION;
    asOf: string;
    inputHash: string;
    preferenceHash: string;
    outputHash: string;
    excludedCount: number;
  }>;
}

const ITEM_KEYS = ['authorId', 'contentLabel', 'createdAt', 'evidenceScore', 'objectId', 'topics'];
const PREF_KEYS = ['blockedAuthors', 'followedAuthors', 'maximumConsecutiveAuthorItems', 'mutedObjectIds', 'topicAffinity', 'visibleLabels', 'weights'];
const WEIGHT_KEYS = ['discovery', 'evidence', 'recency', 'relationship'];
const LABELS = new Set<ContentLabel>(['sfw', 'explicit-music', 'adult-nsfw']);
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9:._/-]{2,255}$/u;
const TOPIC = /^[a-z0-9][a-z0-9-]{0,39}$/u;

function canonical(value: unknown): string {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value)) throw new TypeError('Feed values must use safe integers.');
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (!value || typeof value !== 'object' || Object.getPrototypeOf(value) !== Object.prototype) throw new TypeError('Feed values must be canonical JSON.');
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonical(record[key])}`).join(',')}}`;
}

function digest(value: unknown): string {
  return `u${createHash('sha256').update(canonical(value)).digest('base64url')}`;
}

function exactKeys(value: object, expected: readonly string[], label: string): void {
  const actual = Object.keys(value).sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) throw new TypeError(`${label} contains missing or unsupported fields.`);
}

function score(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0 || (value as number) > 1000) throw new TypeError(`${label} must be an integer from 0 through 1000.`);
  return value as number;
}

function timestamp(value: string, label: string): number {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value)) throw new TypeError(`${label} must use exact UTC milliseconds.`);
  const parsed = Date.parse(value);
  if (!Number.isSafeInteger(parsed)) throw new TypeError(`${label} is invalid.`);
  return parsed;
}

function uniqueStrings(values: readonly string[], label: string, pattern = IDENTIFIER): void {
  if (!Array.isArray(values) || values.length > 10_000 || new Set(values).size !== values.length) throw new TypeError(`${label} must be a bounded array of unique strings.`);
  for (const value of values) if (typeof value !== 'string' || !pattern.test(value)) throw new TypeError(`${label} is invalid.`);
}

function validateItem(item: FeedItem): void {
  if (!item || typeof item !== 'object' || Array.isArray(item)) throw new TypeError('Feed item is invalid.');
  exactKeys(item, ITEM_KEYS, 'Feed item');
  if (!IDENTIFIER.test(item.objectId) || !IDENTIFIER.test(item.authorId)) throw new TypeError('Feed identifiers are invalid.');
  timestamp(item.createdAt, 'Feed item createdAt');
  if (!LABELS.has(item.contentLabel)) throw new TypeError('Feed content label is unsupported.');
  score(item.evidenceScore, 'Feed evidenceScore');
  uniqueStrings(item.topics, 'Feed topics', TOPIC);
}

function validatePreferences(preferences: FeedPreferences): void {
  if (!preferences || typeof preferences !== 'object' || Array.isArray(preferences)) throw new TypeError('Feed preferences are invalid.');
  exactKeys(preferences, PREF_KEYS, 'Feed preferences');
  uniqueStrings(preferences.followedAuthors, 'Followed authors');
  uniqueStrings(preferences.blockedAuthors, 'Blocked authors');
  uniqueStrings(preferences.mutedObjectIds, 'Muted objects');
  if (!Array.isArray(preferences.visibleLabels) || new Set(preferences.visibleLabels).size !== preferences.visibleLabels.length) throw new TypeError('Visible labels must be unique.');
  for (const label of preferences.visibleLabels) if (!LABELS.has(label)) throw new TypeError('Visible label is unsupported.');
  exactKeys(preferences.weights, WEIGHT_KEYS, 'Feed weights');
  for (const [name, value] of Object.entries(preferences.weights)) score(value, `${name} weight`);
  if (!preferences.topicAffinity || typeof preferences.topicAffinity !== 'object' || Array.isArray(preferences.topicAffinity)) throw new TypeError('Topic affinity must be an object.');
  for (const [topic, value] of Object.entries(preferences.topicAffinity)) {
    if (!TOPIC.test(topic)) throw new TypeError('Topic affinity key is invalid.');
    score(value, `Topic affinity for ${topic}`);
  }
  if (!Number.isSafeInteger(preferences.maximumConsecutiveAuthorItems) || preferences.maximumConsecutiveAuthorItems < 1 || preferences.maximumConsecutiveAuthorItems > 10) throw new TypeError('maximumConsecutiveAuthorItems must be between 1 and 10.');
}

function lexical(left: string, right: string): number { return left < right ? -1 : left > right ? 1 : 0; }

function recency(createdAt: number, asOf: number): number {
  const sevenDays = 7 * 24 * 60 * 60 * 1000;
  return Math.max(0, 1000 - Math.floor((Math.min(Math.max(0, asOf - createdAt), sevenDays) * 1000) / sevenDays));
}

function topic(topics: readonly string[], affinity: Readonly<Record<string, number>>): number {
  return topics.length === 0 ? 0 : Math.floor(topics.reduce((sum, name) => sum + (affinity[name] ?? 0), 0) / topics.length);
}

export function rankFeed(items: readonly FeedItem[], preferences: FeedPreferences, options: Readonly<{ asOf: string; limit?: number }>): RankedFeed {
  if (!Array.isArray(items) || items.length > 50_000) throw new TypeError('Feed input must be a bounded array.');
  for (const item of items) validateItem(item);
  if (new Set(items.map((item) => item.objectId)).size !== items.length) throw new TypeError('Feed object identifiers must be unique.');
  validatePreferences(preferences);
  const asOf = timestamp(options.asOf, 'Feed asOf');
  const limit = options.limit ?? 100;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500) throw new TypeError('Feed limit must be between 1 and 500.');
  const followed = new Set(preferences.followedAuthors);
  const blocked = new Set(preferences.blockedAuthors);
  const muted = new Set(preferences.mutedObjectIds);
  const visible = new Set(preferences.visibleLabels);
  const eligible = items.filter((item) => !blocked.has(item.authorId) && !muted.has(item.objectId) && visible.has(item.contentLabel));
  const weightTotal = Object.values(preferences.weights).reduce((sum, value) => sum + value, 0);
  const scored = eligible.map((item): RankedFeedItem => {
    const components = {
      recency: recency(timestamp(item.createdAt, 'Feed item createdAt'), asOf),
      relationship: followed.has(item.authorId) ? 1000 : 0,
      evidence: item.evidenceScore,
      discovery: followed.has(item.authorId) ? 0 : 1000,
      topic: topic(item.topics, preferences.topicAffinity),
    } as const;
    const weighted = components.recency * preferences.weights.recency + components.relationship * preferences.weights.relationship + components.evidence * preferences.weights.evidence + components.discovery * preferences.weights.discovery;
    return { objectId: item.objectId, authorId: item.authorId, score: (weightTotal === 0 ? 0 : Math.floor(weighted / weightTotal)) + components.topic, components };
  });
  scored.sort((left, right) => right.score - left.score || lexical(left.objectId, right.objectId));
  const output: RankedFeedItem[] = [];
  const remaining = [...scored];
  while (remaining.length > 0 && output.length < limit) {
    const recent = output.slice(-preferences.maximumConsecutiveAuthorItems).map((item) => item.authorId);
    const blockedAuthor = recent.length === preferences.maximumConsecutiveAuthorItems && new Set(recent).size === 1 ? recent[0] : undefined;
    const alternate = blockedAuthor === undefined ? 0 : remaining.findIndex((item) => item.authorId !== blockedAuthor);
    output.push(...remaining.splice(alternate < 0 ? 0 : alternate, 1));
  }
  const normalized = items.map((item) => ({ ...item, topics: [...item.topics] })).sort((a, b) => lexical(a.objectId, b.objectId));
  return Object.freeze({
    items: Object.freeze(output),
    receipt: Object.freeze({ policy: FEED_POLICY_ID, version: FEED_VERSION, asOf: options.asOf, inputHash: digest(normalized), preferenceHash: digest(preferences), outputHash: digest(output.map((item) => item.objectId)), excludedCount: items.length - eligible.length }),
  });
}
