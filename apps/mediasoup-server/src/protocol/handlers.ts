import { randomUUID } from "node:crypto";
import type { types } from "mediasoup";
import type { verifyVoiceToken } from "../auth.js";
import type { RoomRegistry } from "../rooms/rooms.js";
import type { NotificationMethod, RequestMethod, TransportOptions } from "./types.js";

const asRecord = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }

  return value as Record<string, unknown>;
};

const asString = (value: unknown): string | null => (typeof value === "string" && value.length > 0 ? value : null);

const asBool = (value: unknown, fallback = false): boolean => (typeof value === "boolean" ? value : fallback);

export class SignalingError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "SignalingError";
  }
}

export type SignalingSession = {
  id: string;
  identified: boolean;
  joined: boolean;
  userId: string | null;
  user: {
    id: string;
    username: string;
    display_name: string;
    avatar_url: string | null;
  } | null;
  roomId: string | null;
  peerId: string | null;
  transportListenIp: string | null;
  transportAnnouncedAddress: string | null;
};

type HandleContext = {
  session: SignalingSession;
  rooms: RoomRegistry;
  verifyVoiceToken: typeof verifyVoiceToken;
  voiceTokenSecret: string;
  debugVoice: boolean;
  log: (...args: unknown[]) => void;
  notifyRoom: (
    roomId: string,
    method: NotificationMethod,
    data: Record<string, unknown>,
    options?: { excludePeerId?: string },
  ) => void;
  syncGuildVoiceState: (roomId: string) => Promise<void>;
};

const ensureIdentified = (session: SignalingSession): void => {
  if (!session.identified || !session.userId || !session.user || !session.roomId || !session.peerId) {
    throw new SignalingError("unauthorized", "Call identify first.");
  }
};

const getJoinedPeer = (context: HandleContext) => {
  const { session, rooms } = context;

  ensureIdentified(session);
  if (!session.joined || !session.roomId || !session.peerId) {
    throw new SignalingError("not_joined", "Call join first.");
  }

  const room = rooms.get(session.roomId);
  if (!room) {
    throw new SignalingError("room_not_found", "Room not found.");
  }

  const peer = room.getPeer(session.peerId);
  if (!peer) {
    throw new SignalingError("peer_not_found", "Peer not found.");
  }

  return { room, peer };
};

const mapTransport = (
  transport: types.WebRtcTransport,
  extra?: {
    iceServers?: TransportOptions["iceServers"];
    iceTransportPolicy?: TransportOptions["iceTransportPolicy"];
  },
): TransportOptions => {
  return {
    id: transport.id,
    iceParameters: transport.iceParameters,
    iceCandidates: transport.iceCandidates,
    dtlsParameters: transport.dtlsParameters,
    ...(transport.sctpParameters ? { sctpParameters: transport.sctpParameters } : {}),
    ...(extra?.iceServers ? { iceServers: extra.iceServers } : {}),
    ...(extra?.iceTransportPolicy ? { iceTransportPolicy: extra.iceTransportPolicy } : {}),
  };
};

const closePeerAndNotify = async (context: HandleContext): Promise<void> => {
  const { session, rooms } = context;
  if (!session.joined || !session.roomId || !session.peerId) {
    return;
  }

  const room = rooms.get(session.roomId);
  if (!room) {
    session.joined = false;
    return;
  }

  const removed = room.removePeer(session.peerId);
  if (removed) {
    context.notifyRoom(
      room.id,
      "peerLeft",
      {
        peerId: removed.id,
      },
      { excludePeerId: removed.id },
    );
  }

  rooms.removeIfEmpty(room.id);
  session.joined = false;

  await context.syncGuildVoiceState(room.id);
};

export const handleRequest = async (
  method: RequestMethod,
  rawData: unknown,
  context: HandleContext,
): Promise<unknown> => {
  const data = asRecord(rawData);

  if (method === "identify") {
    const token = asString(data.token);
    if (!token) {
      throw new SignalingError("bad_request", "token is required.");
    }

    const verification = context.verifyVoiceToken(token, context.voiceTokenSecret);
    if (!verification.identity) {
      if (verification.error === "expired") {
        throw new SignalingError("expired_token", "Voice token expired.");
      }

      throw new SignalingError("invalid_token", "Voice token invalid.");
    }

    const peerId = context.session.peerId ?? randomUUID();

    context.session.identified = true;
    context.session.userId = verification.identity.userId;
    context.session.user = verification.identity.user;
    context.session.roomId = verification.identity.roomId;
    context.session.peerId = peerId;

    if (context.debugVoice) {
      context.log("[voice] identify", {
        userId: verification.identity.userId,
        roomId: verification.identity.roomId,
      });
    }

    return {
      peerId,
      roomId: verification.identity.roomId,
      user: verification.identity.user,
    };
  }

  if (method === "leave") {
    await closePeerAndNotify(context);
    return { ok: true };
  }

  ensureIdentified(context.session);

  if (method === "join") {
    if (!context.session.roomId || !context.session.peerId || !context.session.userId || !context.session.user) {
      throw new SignalingError("unauthorized", "Call identify first.");
    }

    const room = await context.rooms.getOrCreate(context.session.roomId);
    const peer = room.createPeer(context.session.peerId, context.session.userId, context.session.user);
    context.session.joined = true;

    const existingPeers = room.listPeerSummaries(peer.id);
    const existingProducers = room.listProducerSummaries(peer.id);

    if (context.debugVoice) {
      context.log("[voice] join", {
        peerId: peer.id,
        roomId: room.id,
        producers: existingProducers.length,
      });
    }

    context.notifyRoom(
      room.id,
      "peerJoined",
      {
        peerId: peer.id,
        userId: peer.userId,
        displayName: peer.user.display_name,
        user: peer.user,
        state: peer.state,
      },
      { excludePeerId: peer.id },
    );

    await context.syncGuildVoiceState(room.id);

    return {
      peerId: peer.id,
      roomId: room.id,
      user: peer.user,
      routerRtpCapabilities: room.router.rtpCapabilities,
      peers: existingPeers.map(existingPeer => ({
        ...existingPeer,
        userId: existingPeer.user.id,
        displayName: existingPeer.user.display_name,
      })),
      producers: existingProducers,
    };
  }

  const { room, peer } = getJoinedPeer(context);

  if (method === "createWebRtcTransport") {
    const direction = data.direction;
    if (direction !== "send" && direction !== "recv") {
      throw new SignalingError("bad_request", "direction must be send or recv.");
    }

    const previousTransport = direction === "send" ? peer.getSendTransport() : peer.getRecvTransport();
    if (previousTransport) {
      previousTransport.close();
    }

    const transport = await room.createWebRtcTransport(peer, direction, {
      listenIp: context.session.transportListenIp ?? undefined,
      announcedAddress: context.session.transportAnnouncedAddress ?? undefined,
    });

    if (context.debugVoice) {
      context.log("[voice] createWebRtcTransport", {
        peerId: peer.id,
        direction,
        transportId: transport.id,
        iceCandidates: transport.iceCandidates.map(candidate => ({
          foundation: candidate.foundation,
          ip: candidate.ip,
          port: candidate.port,
          protocol: candidate.protocol,
          type: candidate.type,
          tcpType: candidate.tcpType,
        })),
      });
    }

    return mapTransport(transport, {
      iceServers: room.getIceServers(),
      iceTransportPolicy: room.getIceTransportPolicy(),
    });
  }

  if (method === "connectWebRtcTransport") {
    const transportId = asString(data.transportId);
    if (!transportId) {
      throw new SignalingError("bad_request", "transportId is required.");
    }

    const transport = peer.getTransport(transportId);
    if (!transport) {
      throw new SignalingError("transport_not_found", "Transport not found.");
    }

    const dtlsParameters = data.dtlsParameters as types.DtlsParameters | undefined;
    if (!dtlsParameters) {
      throw new SignalingError("bad_request", "dtlsParameters is required.");
    }

    await transport.connect({ dtlsParameters });

    if (context.debugVoice) {
      context.log("[voice] connectWebRtcTransport", {
        peerId: peer.id,
        transportId,
      });
    }

    return { ok: true };
  }

  if (method === "produce") {
    const transportId = asString(data.transportId);
    const kind = data.kind;
    const rtpParameters = data.rtpParameters as types.RtpParameters | undefined;
    const appData = asRecord(data.appData);

    if (!transportId || !rtpParameters || (kind !== "audio" && kind !== "video")) {
      throw new SignalingError("bad_request", "transportId, kind and rtpParameters are required.");
    }

    const sendTransport = peer.getSendTransport();
    if (!sendTransport || sendTransport.id !== transportId) {
      throw new SignalingError("transport_not_found", "Send transport not found.");
    }

    const producer = await sendTransport.produce({
      kind,
      rtpParameters,
      appData,
    });

    peer.addProducer(producer);

    producer.on("transportclose", () => {
      const removed = peer.removeProducer(producer.id);
      if (!removed) {
        return;
      }

      context.notifyRoom(
        room.id,
        "producerClosed",
        {
          producerId: producer.id,
          peerId: peer.id,
        },
        { excludePeerId: peer.id },
      );

      if (context.debugVoice) {
        context.log("[voice] producerClosed", {
          peerId: peer.id,
          producerId: producer.id,
        });
      }
    });

    if (context.debugVoice) {
      context.log("[voice] produce", {
        peerId: peer.id,
        producerId: producer.id,
        kind: producer.kind,
        source: appData.source,
      });
    }

    context.notifyRoom(
      room.id,
      "newProducer",
      {
        producerId: producer.id,
        peerId: peer.id,
        kind: producer.kind,
        appData: appData,
      },
      { excludePeerId: peer.id },
    );

    return {
      producerId: producer.id,
    };
  }

  if (method === "closeProducer") {
    const producerId = asString(data.producerId);
    if (!producerId) {
      throw new SignalingError("bad_request", "producerId is required.");
    }

    const producer = peer.removeProducer(producerId);
    if (!producer) {
      throw new SignalingError("producer_not_found", "Producer not found.");
    }

    producer.close();

    context.notifyRoom(
      room.id,
      "producerClosed",
      {
        producerId,
        peerId: peer.id,
      },
      { excludePeerId: peer.id },
    );

    if (context.debugVoice) {
      context.log("[voice] producerClosed", {
        peerId: peer.id,
        producerId,
      });
    }

    return { ok: true };
  }

  if (method === "consume") {
    const transportId = asString(data.transportId);
    const producerId = asString(data.producerId);
    const rtpCapabilities = data.rtpCapabilities as types.RtpCapabilities | undefined;

    if (!transportId || !producerId || !rtpCapabilities) {
      throw new SignalingError("bad_request", "transportId, producerId and rtpCapabilities are required.");
    }

    const recvTransport = peer.getRecvTransport();
    if (!recvTransport || recvTransport.id !== transportId) {
      throw new SignalingError("transport_not_found", "Recv transport not found.");
    }

    const owner = room.findProducerOwner(producerId);
    if (!owner) {
      throw new SignalingError("producer_not_found", "Producer not found.");
    }

    const canConsume = room.router.canConsume({ producerId, rtpCapabilities });
    if (!canConsume) {
      if (context.debugVoice) {
        context.log("[voice] consume", {
          peerId: peer.id,
          producerId,
          canConsume: false,
        });
      }
      throw new SignalingError(
        "cannot_consume",
        `Router cannot consume producer ${producerId} for peer ${peer.id}. Verify client uses device.recvRtpCapabilities.`,
      );
    }

    const existing = peer.getConsumerByProducerId(producerId);
    if (existing) {
      if (context.debugVoice) {
        context.log("[voice] consume", {
          peerId: peer.id,
          producerId,
          canConsume: true,
          consumerId: existing.id,
          reused: true,
        });
      }

      return {
        consumerId: existing.id,
        producerId,
        peerId: owner.peer.id,
        kind: existing.kind,
        rtpParameters: existing.rtpParameters,
        type: existing.type,
        appData: (owner.producer.appData ?? {}) as Record<string, unknown>,
      };
    }

    const consumer = await recvTransport.consume({
      producerId,
      rtpCapabilities,
      paused: true,
    });

    peer.addConsumer(consumer, producerId);

    consumer.on("transportclose", () => {
      peer.closeConsumer(consumer.id);
    });

    consumer.on("producerclose", () => {
      peer.closeConsumer(consumer.id);
    });

    if (context.debugVoice) {
      context.log("[voice] consume", {
        peerId: peer.id,
        producerId,
        canConsume: true,
        consumerId: consumer.id,
      });
    }

    return {
      consumerId: consumer.id,
      producerId,
      peerId: owner.peer.id,
      kind: consumer.kind,
      rtpParameters: consumer.rtpParameters,
      type: consumer.type,
      appData: (owner.producer.appData ?? {}) as Record<string, unknown>,
    };
  }

  if (method === "resumeConsumer") {
    const consumerId = asString(data.consumerId);
    if (!consumerId) {
      throw new SignalingError("bad_request", "consumerId is required.");
    }

    const consumer = peer.getConsumer(consumerId);
    if (!consumer) {
      throw new SignalingError("consumer_not_found", "Consumer not found.");
    }

    await consumer.resume();

    if (consumer.kind === "video") {
      const maybeConsumer = consumer as types.Consumer & {
        requestKeyFrame?: () => Promise<void> | void;
      };
      if (typeof maybeConsumer.requestKeyFrame === "function") {
        await Promise.resolve(maybeConsumer.requestKeyFrame()).catch(() => undefined);
      }
    }

    if (context.debugVoice) {
      context.log("[voice] resumeConsumer", {
        peerId: peer.id,
        consumerId,
        kind: consumer.kind,
      });
    }

    return { ok: true };
  }

  if (method === "updatePeerState") {
    peer.state = {
      selfMute: asBool(data.selfMute, peer.state.selfMute),
      selfDeaf: asBool(data.selfDeaf, peer.state.selfDeaf),
      screenSharing: asBool(data.screenSharing, peer.state.screenSharing),
    };

    context.notifyRoom(
      room.id,
      "peerStateUpdated",
      {
        peerId: peer.id,
        state: peer.state,
      },
      { excludePeerId: peer.id },
    );

    await context.syncGuildVoiceState(room.id);

    return {
      peerId: peer.id,
      state: peer.state,
    };
  }

  throw new SignalingError("unknown_method", `Unknown method: ${method}`);
};

export const cleanupSession = async (context: HandleContext): Promise<void> => {
  await closePeerAndNotify(context);
};
