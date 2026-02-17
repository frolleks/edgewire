import type { VoicePeer, VoiceServerMessage } from "./types";

type VoiceClientOptions = {
  wsUrl: string;
  token: string;
  autoReconnect?: boolean;
  reconnectBackoffMs?: number[];
  shouldRetryClose?: (code: number) => boolean;
  onWsStateChange?: (state: "closed" | "connecting" | "open") => void;
  onAuthOk?: (payload: { room_id: string; self_socket_id: string }) => void;
  onPong?: (payload: { rttMs: number; lastPongAt: number }) => void;
  onClose?: (payload: { code: number; reason: string; willRetry: boolean }) => void;
  onReady: (payload: { self: VoicePeer; room: { roomId: string }; peers: VoicePeer[] }) => void;
  onPeerJoined: (peer: VoicePeer) => void;
  onPeerLeft: (socketId: string) => void;
  onPeerStateUpdate: (socketId: string, state: VoicePeer["state"]) => void;
  onSignalOffer: (payload: { from: string; sdp: RTCSessionDescriptionInit; screen?: boolean }) => void;
  onSignalAnswer: (payload: { from: string; sdp: RTCSessionDescriptionInit; screen?: boolean }) => void;
  onSignalIce: (payload: { from: string; candidate: RTCIceCandidateInit }) => void;
  onError: (message: string) => void;
};

const safeParse = (value: string): VoiceServerMessage | null => {
  try {
    return JSON.parse(value) as VoiceServerMessage;
  } catch {
    return null;
  }
};

export class VoiceClient {
  private ws: WebSocket | null = null;
  private reconnectTimer: number | null = null;
  private reconnectAttempt = 0;
  private heartbeatTimer: number | null = null;
  private lastPongAt: number | undefined;
  private expectedClose = false;
  private lastPingAt: number | null = null;

  constructor(private readonly options: VoiceClientOptions) {}

  connect(): void {
    this.expectedClose = false;
    this.clearReconnectTimer();
    this.clearHeartbeatTimer();
    this.options.onWsStateChange?.("connecting");

    const separator = this.options.wsUrl.includes("?") ? "&" : "?";
    this.ws = new WebSocket(`${this.options.wsUrl}${separator}token=${encodeURIComponent(this.options.token)}`);

    this.ws.addEventListener("open", () => {
      this.options.onWsStateChange?.("open");
      this.reconnectAttempt = 0;
      this.startHeartbeat();
    });

    this.ws.addEventListener("message", (event) => {
      const data = typeof event.data === "string" ? event.data : "";
      const packet = safeParse(data);
      if (!packet) {
        return;
      }

      switch (packet.op) {
        case "READY": {
          const d = packet.d as {
            self: VoicePeer;
            room: { roomId: string };
            peers: VoicePeer[];
          };
          this.options.onReady(d);
          break;
        }
        case "VOICE_STATE": {
          const d = packet.d as { state: string; room_id: string; self_socket_id: string };
          if (d.state === "auth_ok") {
            this.options.onAuthOk?.({ room_id: d.room_id, self_socket_id: d.self_socket_id });
          }
          break;
        }
        case "PEER_JOINED": {
          const d = packet.d as { peer: VoicePeer };
          this.options.onPeerJoined(d.peer);
          break;
        }
        case "PEER_LEFT": {
          const d = packet.d as { socketId: string };
          this.options.onPeerLeft(d.socketId);
          break;
        }
        case "PEER_STATE_UPDATE": {
          const d = packet.d as { socketId: string; state: VoicePeer["state"] };
          this.options.onPeerStateUpdate(d.socketId, d.state);
          break;
        }
        case "SIGNAL_OFFER": {
          const d = packet.d as { from: string; sdp: RTCSessionDescriptionInit; screen?: boolean };
          this.options.onSignalOffer(d);
          break;
        }
        case "SIGNAL_ANSWER": {
          const d = packet.d as { from: string; sdp: RTCSessionDescriptionInit; screen?: boolean };
          this.options.onSignalAnswer(d);
          break;
        }
        case "SIGNAL_ICE": {
          const d = packet.d as { from: string; candidate: RTCIceCandidateInit };
          this.options.onSignalIce(d);
          break;
        }
        case "ERROR": {
          const d = packet.d as { message?: string };
          this.options.onError(d.message ?? "Voice signaling error.");
          break;
        }
        case "PONG": {
          const now = Date.now();
          this.lastPongAt = now;
          const rttMs = this.lastPingAt ? now - this.lastPingAt : 0;
          this.options.onPong?.({ rttMs, lastPongAt: now });
          break;
        }
        case "PING": {
          const d = packet.d as { ts?: number };
          this.send("PONG", { ts: d.ts ?? Date.now() });
          break;
        }
        default:
          break;
      }
    });

    this.ws.addEventListener("close", (event) => {
      this.clearHeartbeatTimer();
      this.ws = null;
      this.options.onWsStateChange?.("closed");

      const shouldRetry = !this.expectedClose && this.shouldRetry(event.code);
      this.options.onClose?.({
        code: event.code,
        reason: event.reason,
        willRetry: shouldRetry,
      });

      if (shouldRetry) {
        this.scheduleReconnect();
      }
    });
  }

  private shouldRetry(code: number): boolean {
    if (this.options.shouldRetryClose) {
      return this.options.shouldRetryClose(code);
    }

    return ![4001, 4002, 4003].includes(code);
  }

  private scheduleReconnect(): void {
    const backoff = this.options.reconnectBackoffMs ?? [1_000, 2_000, 5_000, 10_000];
    const delay = backoff[Math.min(this.reconnectAttempt, backoff.length - 1)] ?? 10_000;
    this.reconnectAttempt += 1;

    this.clearReconnectTimer();
    this.reconnectTimer = window.setTimeout(() => {
      this.connect();
    }, delay);
  }

  private clearReconnectTimer(): void {
    if (this.reconnectTimer !== null) {
      window.clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  private clearHeartbeatTimer(): void {
    if (this.heartbeatTimer !== null) {
      window.clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  private startHeartbeat(): void {
    this.clearHeartbeatTimer();
    this.lastPongAt = Date.now();

    this.heartbeatTimer = window.setInterval(() => {
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
        return;
      }

      const now = Date.now();
      if (this.lastPongAt && now - this.lastPongAt > 45_000) {
        this.ws.close(4000, "Heartbeat timeout");
        return;
      }

      this.lastPingAt = now;
      this.send("PING", { ts: now });
    }, 15_000);
  }

  send(op: string, d: Record<string, unknown>): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      return;
    }
    this.ws.send(JSON.stringify({ op, d }));
  }

  sendState(state: VoicePeer["state"]): void {
    this.send("MUTE_STATE", state as unknown as Record<string, unknown>);
  }

  close(): void {
    this.expectedClose = true;
    this.clearReconnectTimer();
    this.clearHeartbeatTimer();
    this.ws?.close();
    this.ws = null;
  }
}
