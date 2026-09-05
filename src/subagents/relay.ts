import {
  RELAY_BODY_LIMIT,
  RELAY_MAILBOX_LIMIT,
  RELAY_RUN_LIMIT,
  USAP_VERSION,
  type RelayEnvelope,
} from "./types.ts";

export const RUN_BROADCAST_TARGET = "#run" as const;

export type RelayDelivery = (
  envelope: RelayEnvelope,
) => void | boolean | PromiseLike<void | boolean>;

export interface RelayBrokerOptions {
  bodyLimit?: number;
  mailboxLimit?: number;
  runLimit?: number;
  now?: () => number;
}

export interface RelaySendInput {
  to: string;
  body: string;
  kind?: RelayEnvelope["kind"];
  replyTo?: string;
}

export type RelayRejectCode =
  | "closed"
  | "invalid_body"
  | "body_too_large"
  | "invalid_kind"
  | "invalid_reply"
  | "invalid_target"
  | "self_send"
  | "no_recipients"
  | "mailbox_full"
  | "run_full";

export type RelaySendResult =
  | {
      ok: true;
      status: "queued" | "delivered" | "mixed";
      ids: string[];
      accepted: number;
      queued: number;
      delivered: number;
    }
  | {
      ok: false;
      status: "rejected";
      code: RelayRejectCode;
      message: string;
      accepted: 0;
      queued: 0;
      delivered: 0;
    };

export interface RelayInboxResult {
  messages: RelayEnvelope[];
  nextSeq: number;
  remaining: number;
}

export interface RelayPeer {
  readonly runId: string;
  readonly senderId: string;
  send(input: RelaySendInput): RelaySendResult;
  inbox(afterSeq?: number, limit?: number): RelayInboxResult;
  peers(): string[];
  close(): void;
}

interface DeliveryRegistration {
  token: symbol;
  callback: RelayDelivery;
}

interface RelayRun {
  id: string;
  peers: readonly string[];
  peerSet: ReadonlySet<string>;
  mailboxes: Map<string, RelayEnvelope[]>;
  pending: Map<string, RelayEnvelope[]>;
  deliveries: Map<string, DeliveryRegistration>;
  requests: Map<string, { from: string; to: string }>;
  nextSeq: number;
  accepted: number;
}

const KINDS = new Set<RelayEnvelope["kind"]>(["message", "request", "reply", "status"]);

function positiveInteger(value: number | undefined, fallback: number, name: string): number {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved <= 0) {
    throw new RangeError(`${name} must be a positive safe integer`);
  }
  return resolved;
}

function reject(code: RelayRejectCode, message: string): RelaySendResult {
  return { ok: false, status: "rejected", code, message, accepted: 0, queued: 0, delivered: 0 };
}

/**
 * In-memory relay for bounded subagent runs. A bound peer never accepts a
 * caller-supplied `from` value; its sender identity is captured in a closure.
 */
export class RelayBroker {
  private readonly runs = new Map<string, RelayRun>();
  private readonly bodyLimit: number;
  private readonly mailboxLimit: number;
  private readonly runLimit: number;
  private readonly now: () => number;

  constructor(options: RelayBrokerOptions = {}) {
    this.bodyLimit = positiveInteger(options.bodyLimit, RELAY_BODY_LIMIT, "bodyLimit");
    this.mailboxLimit = positiveInteger(options.mailboxLimit, RELAY_MAILBOX_LIMIT, "mailboxLimit");
    this.runLimit = positiveInteger(options.runLimit, RELAY_RUN_LIMIT, "runLimit");
    this.now = options.now ?? Date.now;
  }

  createRun(runId: string, peerIds: readonly string[]): void {
    if (typeof runId !== "string" || runId.length === 0) {
      throw new TypeError("runId must be a non-empty string");
    }
    if (this.runs.has(runId)) {
      throw new Error(`relay run already exists: ${runId}`);
    }
    if (peerIds.length === 0) {
      throw new Error("a relay run requires at least one peer");
    }

    const peers = [...peerIds];
    const peerSet = new Set<string>();
    for (const peerId of peers) {
      if (typeof peerId !== "string" || peerId.length === 0 || peerId === RUN_BROADCAST_TARGET) {
        throw new TypeError(`invalid relay peer id: ${String(peerId)}`);
      }
      if (peerSet.has(peerId)) {
        throw new Error(`duplicate relay peer id: ${peerId}`);
      }
      peerSet.add(peerId);
    }

    this.runs.set(runId, {
      id: runId,
      peers: Object.freeze(peers),
      peerSet,
      mailboxes: new Map(peers.map((peerId) => [peerId, []])),
      pending: new Map(peers.map((peerId) => [peerId, []])),
      deliveries: new Map(),
      requests: new Map(),
      nextSeq: 1,
      accepted: 0,
    });
  }

  bind(runId: string, senderId: string, onDelivery?: RelayDelivery): RelayPeer {
    const run = this.runs.get(runId);
    if (!run) throw new Error(`unknown relay run: ${runId}`);
    if (!run.peerSet.has(senderId)) throw new Error(`unknown relay peer: ${senderId}`);

    const token = Symbol(senderId);
    if (onDelivery) run.deliveries.set(senderId, { token, callback: onDelivery });
    let closed = false;

    return Object.freeze({
      runId,
      senderId,
      send: (input: RelaySendInput) => {
        if (closed || this.runs.get(runId) !== run) return reject("closed", "relay binding is closed");
        return this.send(run, senderId, input);
      },
      inbox: (afterSeq = 0, limit = this.mailboxLimit) => {
        if (closed || this.runs.get(runId) !== run) {
          return { messages: [], nextSeq: afterSeq, remaining: 0 };
        }
        return this.readInbox(run, senderId, afterSeq, limit);
      },
      peers: () => {
        if (closed || this.runs.get(runId) !== run) return [];
        return run.peers.filter((peerId) => peerId !== senderId);
      },
      close: () => {
        if (closed) return;
        closed = true;
        if (run.deliveries.get(senderId)?.token === token) run.deliveries.delete(senderId);
      },
    });
  }

  bindSender(runId: string, senderId: string, onDelivery?: RelayDelivery): RelayPeer {
    return this.bind(runId, senderId, onDelivery);
  }

  listPeers(runId: string): string[] {
    return [...(this.runs.get(runId)?.peers ?? [])];
  }

  cleanup(runId: string): boolean {
    const run = this.runs.get(runId);
    if (!run) return false;
    run.deliveries.clear();
    run.requests.clear();
    run.pending.clear();
    run.mailboxes.clear();
    return this.runs.delete(runId);
  }

  cleanupRun(runId: string): boolean {
    return this.cleanup(runId);
  }

  private send(run: RelayRun, senderId: string, input: RelaySendInput): RelaySendResult {
    if (!input || typeof input.body !== "string" || input.body.trim().length === 0) {
      return reject("invalid_body", "relay body must be a non-empty string");
    }
    if (input.body.length > this.bodyLimit) {
      return reject("body_too_large", `relay body exceeds ${this.bodyLimit} characters`);
    }
    const kind = input.kind ?? "message";
    if (!KINDS.has(kind)) return reject("invalid_kind", `invalid relay kind: ${String(kind)}`);
    if (typeof input.to !== "string" || input.to.length === 0) {
      return reject("invalid_target", "relay target must be a non-empty string");
    }
    if (input.to === senderId) return reject("self_send", "a relay peer cannot send to itself");

    let recipients: string[];
    if (input.to === RUN_BROADCAST_TARGET) {
      recipients = run.peers.filter((peerId) => peerId !== senderId);
      if (recipients.length === 0) return reject("no_recipients", "broadcast has no other peers");
    } else {
      if (!run.peerSet.has(input.to)) {
        return reject("invalid_target", `unknown relay target: ${input.to}`);
      }
      recipients = [input.to];
    }

    if (kind === "reply") {
      if (typeof input.replyTo !== "string" || input.replyTo.length === 0) {
        return reject("invalid_reply", "relay replies require a request ID");
      }
      const request = run.requests.get(input.replyTo);
      if (!request || recipients.length !== 1 || request.from !== recipients[0] || request.to !== senderId) {
        return reject("invalid_reply", `unknown or mismatched relay request: ${input.replyTo}`);
      }
    } else if (input.replyTo !== undefined) {
      return reject("invalid_reply", "replyTo is valid only for relay replies");
    }

    if (run.accepted + recipients.length > this.runLimit) {
      return reject("run_full", `relay run has reached its ${this.runLimit}-message limit`);
    }
    for (const recipient of recipients) {
      const reserved = (run.mailboxes.get(recipient)?.length ?? this.mailboxLimit)
        + (run.pending.get(recipient)?.length ?? this.mailboxLimit);
      if (reserved >= this.mailboxLimit) {
        return reject("mailbox_full", `relay mailbox is full: ${recipient}`);
      }
    }

    let queued = 0;
    let delivered = 0;
    const ids: string[] = [];
    for (const recipient of recipients) {
      const seq = run.nextSeq++;
      const envelope: RelayEnvelope = Object.freeze({
        version: USAP_VERSION,
        runId: run.id,
        id: `${run.id}:${seq}`,
        seq,
        from: senderId,
        to: input.to === RUN_BROADCAST_TARGET ? RUN_BROADCAST_TARGET : recipient,
        kind,
        body: input.body,
        ...(input.replyTo === undefined ? {} : { replyTo: input.replyTo }),
        createdAt: this.now(),
      });
      ids.push(envelope.id);
      run.accepted += 1;
      if (kind === "request") run.requests.set(envelope.id, { from: senderId, to: recipient });

      // Preserve per-recipient FIFO across steering and inbox delivery. A later
      // direct delivery must not advance a receiver past an older queued or
      // unresolved message that may still need mailbox fallback.
      const backlog = run.mailboxes.get(recipient)!.length + run.pending.get(recipient)!.length;
      const delivery = backlog === 0 ? run.deliveries.get(recipient)?.callback : undefined;
      let handled = false;
      let pending: PromiseLike<void | boolean> | undefined;
      if (delivery) {
        try {
          const outcome = delivery(envelope);
          if (
            outcome !== null
            && typeof outcome === "object"
            && typeof (outcome as PromiseLike<void | boolean>).then === "function"
          ) {
            pending = outcome as PromiseLike<void | boolean>;
          } else {
            handled = outcome !== false;
          }
        } catch {
          // An active receiver can decline or fail; its bounded mailbox is the fallback.
        }
      }
      if (handled) {
        delivered += 1;
      } else if (pending) {
        // Reserve mailbox capacity while steering is unresolved, but keep the
        // envelope out of inbox reads so it cannot be consumed there and then
        // delivered a second time by a late successful acknowledgement.
        const mailbox = run.mailboxes.get(recipient)!;
        const pendingMailbox = run.pending.get(recipient)!;
        pendingMailbox.push(envelope);
        queued += 1;
        const settle = (outcome: void | boolean) => {
          if (this.runs.get(run.id) !== run) return;
          const index = pendingMailbox.indexOf(envelope);
          if (index >= 0) pendingMailbox.splice(index, 1);
          if (outcome === false) {
            mailbox.push(envelope);
            mailbox.sort((a, b) => a.seq - b.seq);
          }
        };
        void Promise.resolve(pending).then(settle, () => settle(false));
      } else {
        run.mailboxes.get(recipient)!.push(envelope);
        queued += 1;
      }
    }

    if (kind === "reply") run.requests.delete(input.replyTo!);
    const status = queued === 0 ? "delivered" : delivered === 0 ? "queued" : "mixed";
    return { ok: true, status, ids, accepted: recipients.length, queued, delivered };
  }

  private readInbox(run: RelayRun, peerId: string, afterSeq: number, limit: number): RelayInboxResult {
    if (!Number.isSafeInteger(afterSeq) || afterSeq < 0) {
      throw new RangeError("afterSeq must be a non-negative safe integer");
    }
    if (!Number.isSafeInteger(limit) || limit < 0) {
      throw new RangeError("limit must be a non-negative safe integer");
    }

    const mailbox = run.mailboxes.get(peerId)!;
    // Never publish a cursor beyond an unresolved delivery: it may still
    // reject and need its original sequence in the inbox.
    const barrier = Math.min(...run.pending.get(peerId)!.map((message) => message.seq));
    const cursor = Math.min(afterSeq, barrier - 1);
    while (mailbox.length > 0 && mailbox[0].seq <= cursor) mailbox.shift();
    const available = mailbox.findIndex((message) => message.seq >= barrier);
    const messages = mailbox.splice(0, Math.min(limit, this.mailboxLimit,
      available < 0 ? mailbox.length : available));
    return {
      messages,
      nextSeq: messages.length > 0 ? messages[messages.length - 1].seq : cursor,
      remaining: mailbox.length,
    };
  }
}
