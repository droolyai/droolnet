import { canonicalize, sha256Multibase } from "./index.js";

const PROTOCOL = "wokenet.social.operation";
const VERSION = 1 as const;
const ACTOR_RE = /^wokeid:v1:u[A-Za-z0-9_-]{43}$/u;
const OP_RE = /^wokeop:v1:u[A-Za-z0-9_-]{43}$/u;
const OBJECT_RE = /^(?:profile|post|comment|community|media|channel|message):[a-zA-Z0-9._:-]{1,160}$/u;
const BLOCK_RE = /^[a-zA-Z0-9._:-]{1,96}$/u;

export type ProfileField = "displayName" | "handle" | "bio" | "avatar";
export type EdgeKind = "follow" | "reaction" | "membership" | "bookmark";
export type SocialOperationInput =
  | { type: "profile.field.set"; objectId: string; payload: { field: ProfileField; value: string | null } }
  | { type: "post.block.set"; objectId: string; payload: { blockId: string; after: string | null; kind: "text" | "media"; value: string } }
  | { type: "post.block.delete"; objectId: string; payload: { blockId: string } }
  | { type: "edge.add"; objectId: string; payload: { edge: EdgeKind; subject: string; target: string; value: string | null } }
  | { type: "edge.remove"; objectId: string; payload: { edge: EdgeKind; subject: string; target: string; observedAddIds: readonly string[] } }
  | { type: "object.tombstone"; objectId: string; payload: { reason: "author_delete" | "moderator_hide" } };

export type SocialOperation = SocialOperationInput & {
  protocol: typeof PROTOCOL;
  version: typeof VERSION;
  opId: string;
  actor: string;
  sequence: number;
  createdAt: string;
};

export interface MaterializedSocialState {
  profiles: Readonly<Record<string, Readonly<Partial<Record<ProfileField, string | null>>>>>;
  posts: Readonly<Record<string, Readonly<{ deleted: boolean; blocks: readonly Readonly<{ id: string; kind: "text" | "media"; value: string }>[] }>>>;
  edges: readonly Readonly<{ id: string; kind: EdgeKind; subject: string; target: string; value: string | null; addId: string }>[];
  tombstones: readonly string[];
  operationCount: number;
  receipt: string;
}

export class SocialCrdtError extends Error {
  constructor(public readonly code: string, message: string) { super(message); this.name = "SocialCrdtError"; }
}
function fail(code: string, message: string): never { throw new SocialCrdtError(code, message); }
function canonicalTime(value: string): boolean { return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value) && Number.isFinite(Date.parse(value)); }
function boundText(value: unknown, max: number, nullable = false): asserts value is string | null {
  if (nullable && value === null) return;
  if (typeof value !== "string" || value.includes("\0") || Buffer.byteLength(value, "utf8") > max) fail("invalid_text", `Text must be valid and at most ${max} bytes.`);
}
function operationBody(operation: Omit<SocialOperation, "opId">): Omit<SocialOperation, "opId"> { return operation; }
function deriveOpId(operation: Omit<SocialOperation, "opId">): string { return `wokeop:v1:${sha256Multibase(Buffer.from(canonicalize(operation)))}`; }
function edgeId(edge: EdgeKind, subject: string, target: string): string { return `${edge}:${subject}:${target}`; }
function compareClock(a: SocialOperation, b: SocialOperation): number { return a.sequence - b.sequence || a.actor.localeCompare(b.actor) || a.opId.localeCompare(b.opId); }

export function createSocialOperation(input: SocialOperationInput & { actor: string; sequence: number; createdAt?: string }): SocialOperation {
  const { actor, sequence, createdAt = new Date().toISOString(), ...operation } = input;
  const body = operationBody({ protocol: PROTOCOL, version: VERSION, actor, sequence, createdAt, ...operation } as Omit<SocialOperation, "opId">);
  const result = { ...body, opId: deriveOpId(body) } as SocialOperation;
  validateSocialOperation(result);
  return Object.freeze(result);
}

export function validateSocialOperation(operation: SocialOperation): true {
  if (operation.protocol !== PROTOCOL || operation.version !== VERSION) fail("unsupported_protocol", "Unsupported social operation protocol.");
  const { opId, ...body } = operation;
  if (!OP_RE.test(opId) || deriveOpId(operationBody(body as Omit<SocialOperation, "opId">)) !== opId) fail("invalid_op_id", "Operation ID does not match canonical content.");
  if (!ACTOR_RE.test(operation.actor)) fail("invalid_actor", "Actor must be a WOKE device identity.");
  if (!Number.isSafeInteger(operation.sequence) || operation.sequence < 1) fail("invalid_sequence", "Sequence must be a positive safe integer.");
  if (!canonicalTime(operation.createdAt)) fail("invalid_time", "createdAt must be canonical UTC.");
  if (!OBJECT_RE.test(operation.objectId)) fail("invalid_object_id", "Object ID is outside the social namespace.");
  const payload = operation.payload as Record<string, unknown>;
  if (operation.type === "profile.field.set") {
    if (!operation.objectId.startsWith("profile:") || !["displayName", "handle", "bio", "avatar"].includes(String(payload.field))) fail("invalid_profile", "Invalid profile field operation.");
    boundText(payload.value, payload.field === "bio" ? 2_000 : 320, true);
  } else if (operation.type === "post.block.set") {
    if (!operation.objectId.startsWith("post:") && !operation.objectId.startsWith("comment:")) fail("invalid_post", "Block operations require post or comment objects.");
    if (typeof payload.blockId !== "string" || !BLOCK_RE.test(payload.blockId)) fail("invalid_block", "Invalid block ID.");
    if (payload.after !== null && (typeof payload.after !== "string" || !BLOCK_RE.test(payload.after))) fail("invalid_block", "Invalid predecessor block ID.");
    if (payload.kind !== "text" && payload.kind !== "media") fail("invalid_block", "Invalid block kind.");
    boundText(payload.value, payload.kind === "text" ? 32_000 : 2_048);
  } else if (operation.type === "post.block.delete") {
    if (typeof payload.blockId !== "string" || !BLOCK_RE.test(payload.blockId)) fail("invalid_block", "Invalid deleted block ID.");
  } else if (operation.type === "edge.add" || operation.type === "edge.remove") {
    if (!["follow", "reaction", "membership", "bookmark"].includes(String(payload.edge))) fail("invalid_edge", "Invalid edge kind.");
    boundText(payload.subject, 200); boundText(payload.target, 200);
    if (operation.type === "edge.add") boundText(payload.value, 128, true);
    else if (!Array.isArray(payload.observedAddIds) || payload.observedAddIds.length > 256 || payload.observedAddIds.some((id) => typeof id !== "string" || !OP_RE.test(id))) fail("invalid_edge_remove", "Edge removals require bounded observed add IDs.");
  } else if (operation.type === "object.tombstone") {
    if (payload.reason !== "author_delete" && payload.reason !== "moderator_hide") fail("invalid_tombstone", "Invalid tombstone reason.");
  } else fail("invalid_type", "Unsupported social operation type.");
  return true;
}

export function materializeSocialState(operations: readonly SocialOperation[]): MaterializedSocialState {
  const unique = new Map<string, SocialOperation>();
  for (const operation of operations) { validateSocialOperation(operation); if (unique.has(operation.opId)) fail("duplicate_operation", "Duplicate social operation."); unique.set(operation.opId, operation); }
  const ordered = [...unique.values()].sort(compareClock);
  const profileRegisters = new Map<string, Map<ProfileField, SocialOperation>>();
  const blockRegisters = new Map<string, Map<string, SocialOperation>>();
  const blockDeletes = new Map<string, Map<string, SocialOperation>>();
  const edgeAdds = new Map<string, Map<string, SocialOperation>>();
  const removedAdds = new Set<string>();
  const tombstones = new Map<string, SocialOperation>();
  for (const operation of ordered) {
    if (operation.type === "profile.field.set") {
      const fields = profileRegisters.get(operation.objectId) ?? new Map<ProfileField, SocialOperation>(); const previous = fields.get(operation.payload.field);
      if (!previous || compareClock(previous, operation) < 0) fields.set(operation.payload.field, operation); profileRegisters.set(operation.objectId, fields);
    } else if (operation.type === "post.block.set") {
      const blocks = blockRegisters.get(operation.objectId) ?? new Map<string, SocialOperation>(); const previous = blocks.get(operation.payload.blockId);
      if (!previous || compareClock(previous, operation) < 0) blocks.set(operation.payload.blockId, operation); blockRegisters.set(operation.objectId, blocks);
    } else if (operation.type === "post.block.delete") {
      const deletes = blockDeletes.get(operation.objectId) ?? new Map<string, SocialOperation>(); const previous = deletes.get(operation.payload.blockId);
      if (!previous || compareClock(previous, operation) < 0) deletes.set(operation.payload.blockId, operation); blockDeletes.set(operation.objectId, deletes);
    } else if (operation.type === "edge.add") {
      const key = edgeId(operation.payload.edge, operation.payload.subject, operation.payload.target); const adds = edgeAdds.get(key) ?? new Map<string, SocialOperation>(); adds.set(operation.opId, operation); edgeAdds.set(key, adds);
    } else if (operation.type === "edge.remove") for (const addId of operation.payload.observedAddIds) removedAdds.add(addId);
    else if (operation.type === "object.tombstone") { const previous = tombstones.get(operation.objectId); if (!previous || compareClock(previous, operation) < 0) tombstones.set(operation.objectId, operation); }
  }
  const profiles: Record<string, Partial<Record<ProfileField, string | null>>> = {};
  for (const [objectId, fields] of [...profileRegisters].sort(([a], [b]) => a.localeCompare(b))) { const profile: Partial<Record<ProfileField, string | null>> = {}; for (const [field, operation] of [...fields].sort(([a], [b]) => a.localeCompare(b))) profile[field] = (operation as Extract<SocialOperation, { type: "profile.field.set" }>).payload.value; profiles[objectId] = profile; }
  const posts: Record<string, { deleted: boolean; blocks: { id: string; kind: "text" | "media"; value: string }[] }> = {};
  for (const [objectId, blocks] of [...blockRegisters].sort(([a], [b]) => a.localeCompare(b))) {
    const visible = [...blocks.values()].filter((operation) => { const deleted = blockDeletes.get(objectId)?.get((operation as Extract<SocialOperation, { type: "post.block.set" }>).payload.blockId); return !deleted || compareClock(deleted, operation) < 0; });
    visible.sort((a, b) => { const left = a as Extract<SocialOperation, { type: "post.block.set" }>; const right = b as typeof left; return String(left.payload.after).localeCompare(String(right.payload.after)) || compareClock(left, right); });
    posts[objectId] = { deleted: tombstones.has(objectId), blocks: visible.map((operation) => { const block = operation as Extract<SocialOperation, { type: "post.block.set" }>; return { id: block.payload.blockId, kind: block.payload.kind, value: block.payload.value }; }) };
  }
  const edges = [...edgeAdds.entries()].flatMap(([id, adds]) => [...adds.values()].filter((operation) => !removedAdds.has(operation.opId)).map((operation) => { const edge = operation as Extract<SocialOperation, { type: "edge.add" }>; return { id, kind: edge.payload.edge, subject: edge.payload.subject, target: edge.payload.target, value: edge.payload.value, addId: edge.opId }; })).sort((a, b) => a.id.localeCompare(b.id) || a.addId.localeCompare(b.addId));
  const stateWithoutReceipt = { profiles, posts, edges, tombstones: [...tombstones.keys()].sort(), operationCount: ordered.length };
  return Object.freeze({ ...stateWithoutReceipt, receipt: sha256Multibase(Buffer.from(canonicalize({ operations: ordered.map((operation) => operation.opId), state: stateWithoutReceipt }))) });
}

export const SOCIAL_CRDT_CONTRACT = Object.freeze({ protocol: PROTOCOL, version: VERSION, status: "implemented_research_subset", merge: "field_registers_observed_remove_edges_ordered_blocks_tombstones", deterministic: true, productionRelayIntegration: false });
