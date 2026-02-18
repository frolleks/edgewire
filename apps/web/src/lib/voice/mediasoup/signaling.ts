import type { SignalingNotification, SignalingRequest, SignalingResponse } from "./types";

type WsState = "closed" | "connecting" | "open";

type SignalingOptions = {
  wsUrl: string;
  onWsStateChange?: (state: WsState) => void;
  onNotification?: (notification: SignalingNotification) => void;
  onClose?: (event: CloseEvent) => void;
};

type PendingRequest = {
  resolve: (value: unknown) => void;
  reject: (reason: Error) => void;
  timeoutId: number;
};

const asResponse = (value: unknown): SignalingResponse | null => {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }

  const object = value as Partial<SignalingResponse>;
  if (typeof object.id !== "string" || typeof object.ok !== "boolean") {
    return null;
  }

  return object as SignalingResponse;
};

const asNotification = (value: unknown): SignalingNotification | null => {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }

  const object = value as Partial<SignalingNotification>;
  if (object.notification !== true || typeof object.method !== "string") {
    return null;
  }

  return object as SignalingNotification;
};

export class MediasoupSignaling {
  private ws: WebSocket | null = null;
  private state: WsState = "closed";
  private requestCounter = 0;
  private readonly pending = new Map<string, PendingRequest>();

  constructor(private readonly options: SignalingOptions) {}

  connect(): Promise<void> {
    if (this.ws && this.state === "open") {
      return Promise.resolve();
    }

    this.setState("connecting");

    return new Promise((resolve, reject) => {
      const ws = new WebSocket(this.options.wsUrl);
      this.ws = ws;

      ws.addEventListener("open", () => {
        this.setState("open");
        resolve();
      });

      ws.addEventListener("error", () => {
        if (this.state !== "open") {
          reject(new Error("Failed to connect signaling websocket."));
        }
      });

      ws.addEventListener("message", event => {
        const raw = typeof event.data === "string" ? event.data : "";
        if (!raw) {
          return;
        }

        let parsed: unknown;
        try {
          parsed = JSON.parse(raw);
        } catch {
          return;
        }

        const notification = asNotification(parsed);
        if (notification) {
          this.options.onNotification?.(notification);
          return;
        }

        const response = asResponse(parsed);
        if (!response) {
          return;
        }

        const pending = this.pending.get(response.id);
        if (!pending) {
          return;
        }

        window.clearTimeout(pending.timeoutId);
        this.pending.delete(response.id);

        if (!response.ok) {
          pending.reject(new Error(`${response.error.code}: ${response.error.message}`));
          return;
        }

        pending.resolve(response.data);
      });

      ws.addEventListener("close", event => {
        this.setState("closed");
        this.ws = null;

        for (const [id, pending] of this.pending.entries()) {
          window.clearTimeout(pending.timeoutId);
          pending.reject(new Error("Signaling websocket closed."));
          this.pending.delete(id);
        }

        this.options.onClose?.(event);
      });
    });
  }

  async request<T>(method: SignalingRequest["method"], data: Record<string, unknown>, timeoutMs = 15_000): Promise<T> {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new Error("Signaling websocket is not open.");
    }

    const id = `${Date.now()}-${this.requestCounter}`;
    this.requestCounter += 1;

    const payload: SignalingRequest = {
      id,
      method,
      data,
    };

    return await new Promise<T>((resolve, reject) => {
      const timeoutId = window.setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Signaling request timed out: ${method}`));
      }, timeoutMs);

      this.pending.set(id, {
        resolve: (value) => resolve(value as T),
        reject,
        timeoutId,
      });

      this.ws?.send(JSON.stringify(payload));
    });
  }

  close(): void {
    if (!this.ws) {
      return;
    }

    this.ws.close();
    this.ws = null;
    this.setState("closed");
  }

  private setState(state: WsState): void {
    this.state = state;
    this.options.onWsStateChange?.(state);
  }
}
