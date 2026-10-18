import { z } from 'zod';
import { MatchId, MESSAGE_TYPES, PlayerId, payloadSchemas } from './messages.js';
import type { MessageType, PayloadInput, PayloadOf } from './messages.js';
import { PROTOCOL_VERSION } from './version.js';

/**
 * Every frame on the wire is one Envelope. `seq` is per sender and strictly increasing within a
 * connection; `ts` is the sender's clock. `matchId` is null only on HELLO / HELLO_ACK / REFUSE,
 * before the host has announced the match.
 */
export const EnvelopeBase = z.object({
  v: z.literal(PROTOCOL_VERSION).describe('Protocol version; peers with a different value refuse each other.'),
  type: z.enum(MESSAGE_TYPES as [MessageType, ...MessageType[]]),
  matchId: MatchId.nullable(),
  seq: z.number().int().min(0).describe('Per-sender, strictly increasing within a connection.'),
  ts: z.number().int().describe("Sender's clock, ms since epoch. Informational."),
  from: PlayerId.describe('The original sender. Preserved when the host mirrors STATE / DMD_FRAME.'),
  payload: z.unknown(),
});

export type Message<T extends MessageType = MessageType> = {
  v: typeof PROTOCOL_VERSION;
  type: T;
  matchId: string | null;
  seq: number;
  ts: number;
  from: PlayerId;
  payload: PayloadOf<T>;
};

export type AnyMessage = { [T in MessageType]: Message<T> }[MessageType];

export class ProtocolError extends Error {
  constructor(
    message: string,
    public readonly issues: unknown = undefined,
  ) {
    super(message);
    this.name = 'ProtocolError';
  }
}

/** Parse and validate a decoded JSON value into a typed message. Throws ProtocolError. */
export function parseMessage(value: unknown): AnyMessage {
  const base = EnvelopeBase.safeParse(value);
  if (!base.success) throw new ProtocolError('invalid envelope', base.error.issues);
  const type = base.data.type;
  const schema = payloadSchemas[type];
  const payload = schema.safeParse(base.data.payload);
  if (!payload.success) throw new ProtocolError(`invalid ${type} payload`, payload.error.issues);
  return { ...base.data, type, payload: payload.data } as AnyMessage;
}

/** Parse a wire frame (JSON text). Throws ProtocolError on bad JSON or a bad message. */
export function decodeFrame(text: string): AnyMessage {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (e) {
    throw new ProtocolError('frame is not JSON', String(e));
  }
  return parseMessage(value);
}

export function encodeFrame(msg: AnyMessage): string {
  return JSON.stringify(msg);
}

export type BuildOptions = { matchId: string | null; seq: number; from: PlayerId; ts?: number };

/** Build a validated message. Applies payload defaults. Throws ProtocolError if the payload is invalid. */
export function buildMessage<T extends MessageType>(type: T, payload: PayloadInput<T>, opts: BuildOptions): Message<T> {
  const parsed = payloadSchemas[type].safeParse(payload);
  if (!parsed.success) throw new ProtocolError(`invalid ${type} payload`, parsed.error.issues);
  return {
    v: PROTOCOL_VERSION,
    type,
    matchId: opts.matchId,
    seq: opts.seq,
    ts: opts.ts ?? Date.now(),
    from: opts.from,
    payload: parsed.data as PayloadOf<T>,
  };
}

export function isType<T extends MessageType>(msg: AnyMessage, type: T): msg is Extract<AnyMessage, { type: T }> {
  return msg.type === type;
}
