import type { PeerLinkState } from "./types";

type WebRtcOptions = {
  iceServers: RTCIceServer[];
  localAudioStream?: MediaStream | null;
  onIceCandidate: (to: string, candidate: RTCIceCandidateInit) => void;
  onRemoteTrack: (peerSocketId: string, stream: MediaStream, track: MediaStreamTrack) => void;
  onPeerStateChange?: (peerSocketId: string, state: PeerLinkState, ice: string) => void;
  onPeerConnecting?: () => void;
  onPeerConnected?: () => void;
  onPeerFailed?: () => void;
  onPeerDisconnected?: () => void;
  onRenegotiate?: (peerSocketId: string, offer: RTCSessionDescriptionInit) => void;
};

export class WebRtcMesh {
  private readonly peerConnections = new Map<string, RTCPeerConnection>();
  private readonly pendingIceCandidates = new Map<string, RTCIceCandidateInit[]>();
  private readonly restartAttempts = new Map<string, number>();
  private readonly disconnectTimers = new Map<string, number>();

  private localAudioTrack: MediaStreamTrack | null = null;
  private localAudioStream: MediaStream | null = null;

  private screenTrack: MediaStreamTrack | null = null;

  constructor(private readonly options: WebRtcOptions) {
    this.localAudioStream = options.localAudioStream ?? null;
    this.localAudioTrack = this.localAudioStream?.getAudioTracks()[0] ?? null;
  }

  private ensurePeerConnection(peerSocketId: string): RTCPeerConnection {
    const existing = this.peerConnections.get(peerSocketId);
    if (existing) {
      return existing;
    }

    const connection = new RTCPeerConnection({ iceServers: this.options.iceServers });
    this.attachLocalAudioToPeer(connection);
    if (this.screenTrack) {
      const stream = new MediaStream([this.screenTrack]);
      connection.addTrack(this.screenTrack, stream);
    }

    connection.onicecandidate = (event) => {
      if (!event.candidate) {
        return;
      }
      this.options.onIceCandidate(peerSocketId, event.candidate.toJSON());
    };

    connection.ontrack = (event) => {
      const stream = event.streams[0] ?? new MediaStream([event.track]);
      this.options.onRemoteTrack(peerSocketId, stream, event.track);
    };

    connection.onconnectionstatechange = () => {
      const state = connection.connectionState;
      if (state === "connected") {
        this.options.onPeerConnected?.();
      } else if (state === "connecting") {
        this.options.onPeerConnecting?.();
      } else if (state === "failed") {
        this.options.onPeerFailed?.();
      } else if (state === "disconnected") {
        this.options.onPeerDisconnected?.();
      }
      this.emitPeerState(peerSocketId, state, connection.iceConnectionState);
    };

    connection.oniceconnectionstatechange = () => {
      const iceState = connection.iceConnectionState;
      this.emitPeerState(peerSocketId, connection.connectionState, iceState);

      if (iceState === "failed") {
        void this.attemptIceRestart(peerSocketId, connection);
      }

      if (iceState === "disconnected") {
        this.scheduleDisconnectedRestart(peerSocketId, connection);
      } else {
        this.clearDisconnectedTimer(peerSocketId);
      }
    };

    this.peerConnections.set(peerSocketId, connection);
    return connection;
  }

  private emitPeerState(peerSocketId: string, connectionState: RTCPeerConnectionState, iceState: RTCIceConnectionState): void {
    const mapped: PeerLinkState =
      connectionState === "connected"
        ? "connected"
        : connectionState === "connecting"
          ? "connecting"
          : connectionState === "failed"
            ? "failed"
            : connectionState === "disconnected"
              ? "disconnected"
              : connectionState === "closed"
                ? "closed"
                : "new";
    this.options.onPeerStateChange?.(peerSocketId, mapped, iceState);
  }

  private async attemptIceRestart(peerSocketId: string, pc: RTCPeerConnection): Promise<void> {
    const attempts = this.restartAttempts.get(peerSocketId) ?? 0;
    if (attempts >= 1) {
      return;
    }
    this.restartAttempts.set(peerSocketId, attempts + 1);

    try {
      pc.restartIce();
      const offer = await pc.createOffer({ iceRestart: true });
      await pc.setLocalDescription(offer);
      this.options.onRenegotiate?.(peerSocketId, offer);
    } catch {
      // leave peer as failed if restart fails
    }
  }

  private scheduleDisconnectedRestart(peerSocketId: string, pc: RTCPeerConnection): void {
    if (this.disconnectTimers.has(peerSocketId)) {
      return;
    }

    const timer = window.setTimeout(() => {
      this.disconnectTimers.delete(peerSocketId);
      void this.attemptIceRestart(peerSocketId, pc);
    }, 10_000);
    this.disconnectTimers.set(peerSocketId, timer);
  }

  private clearDisconnectedTimer(peerSocketId: string): void {
    const timer = this.disconnectTimers.get(peerSocketId);
    if (timer !== undefined) {
      window.clearTimeout(timer);
      this.disconnectTimers.delete(peerSocketId);
    }
  }

  private attachLocalAudioToPeer(pc: RTCPeerConnection): void {
    if (!this.localAudioTrack || !this.localAudioStream) {
      return;
    }

    const existingSender = pc.getSenders().find(sender => sender.track?.kind === "audio");
    if (existingSender) {
      void existingSender.replaceTrack(this.localAudioTrack);
      return;
    }

    pc.addTrack(this.localAudioTrack, this.localAudioStream);
  }

  setLocalAudioTrack(track: MediaStreamTrack | null, stream: MediaStream | null): void {
    this.localAudioTrack = track;
    this.localAudioStream = stream;

    for (const pc of this.peerConnections.values()) {
      const sender = pc.getSenders().find(item => item.track?.kind === "audio");
      if (sender) {
        void sender.replaceTrack(track);
      } else if (track && stream) {
        pc.addTrack(track, stream);
      }
    }
  }

  async createOffer(peerSocketId: string): Promise<RTCSessionDescriptionInit> {
    const pc = this.ensurePeerConnection(peerSocketId);
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    return offer;
  }

  async handleOffer(peerSocketId: string, sdp: RTCSessionDescriptionInit): Promise<RTCSessionDescriptionInit> {
    const pc = this.ensurePeerConnection(peerSocketId);
    await pc.setRemoteDescription(sdp);
    await this.flushPendingIceCandidates(peerSocketId, pc);
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    return answer;
  }

  async handleAnswer(peerSocketId: string, sdp: RTCSessionDescriptionInit): Promise<void> {
    const pc = this.ensurePeerConnection(peerSocketId);
    if (pc.signalingState !== "have-local-offer") {
      return;
    }

    try {
      await pc.setRemoteDescription(sdp);
    } catch (error) {
      if (error instanceof DOMException && error.name === "InvalidStateError") {
        return;
      }
      throw error;
    }

    await this.flushPendingIceCandidates(peerSocketId, pc);
  }

  async addIceCandidate(peerSocketId: string, candidate: RTCIceCandidateInit): Promise<void> {
    const pc = this.ensurePeerConnection(peerSocketId);
    if (!pc.remoteDescription) {
      const queued = this.pendingIceCandidates.get(peerSocketId) ?? [];
      queued.push(candidate);
      this.pendingIceCandidates.set(peerSocketId, queued);
      return;
    }

    try {
      await pc.addIceCandidate(candidate);
    } catch (error) {
      if (
        error instanceof DOMException &&
        (error.name === "OperationError" || error.name === "InvalidStateError")
      ) {
        return;
      }
      throw error;
    }
  }

  private async flushPendingIceCandidates(peerSocketId: string, pc: RTCPeerConnection): Promise<void> {
    const queued = this.pendingIceCandidates.get(peerSocketId);
    if (!queued || queued.length === 0 || !pc.remoteDescription) {
      return;
    }

    this.pendingIceCandidates.delete(peerSocketId);
    for (const candidate of queued) {
      try {
        await pc.addIceCandidate(candidate);
      } catch (error) {
        if (
          error instanceof DOMException &&
          (error.name === "OperationError" || error.name === "InvalidStateError")
        ) {
          continue;
        }
        throw error;
      }
    }
  }

  async startScreenshare(track: MediaStreamTrack): Promise<void> {
    this.screenTrack = track;
    for (const pc of this.peerConnections.values()) {
      const sender = pc.getSenders().find((item) => item.track?.kind === "video");
      if (sender) {
        await sender.replaceTrack(track);
      } else {
        pc.addTrack(track, new MediaStream([track]));
      }
    }
  }

  async stopScreenshare(): Promise<void> {
    this.screenTrack = null;
    for (const pc of this.peerConnections.values()) {
      const sender = pc.getSenders().find((item) => item.track?.kind === "video");
      if (sender) {
        await sender.replaceTrack(null);
      }
    }
  }

  removePeer(peerSocketId: string): void {
    const pc = this.peerConnections.get(peerSocketId);
    if (!pc) {
      return;
    }
    pc.close();
    this.peerConnections.delete(peerSocketId);
    this.pendingIceCandidates.delete(peerSocketId);
    this.restartAttempts.delete(peerSocketId);
    this.clearDisconnectedTimer(peerSocketId);
  }

  async renegotiateAll(): Promise<Array<{ peerSocketId: string; offer: RTCSessionDescriptionInit }>> {
    const offers: Array<{ peerSocketId: string; offer: RTCSessionDescriptionInit }> = [];
    for (const peerSocketId of this.peerConnections.keys()) {
      const offer = await this.createOffer(peerSocketId);
      offers.push({ peerSocketId, offer });
    }
    return offers;
  }

  closeAll(): void {
    for (const [peerSocketId] of this.peerConnections) {
      this.removePeer(peerSocketId);
    }

    for (const timer of this.disconnectTimers.values()) {
      window.clearTimeout(timer);
    }
    this.disconnectTimers.clear();
  }
}
