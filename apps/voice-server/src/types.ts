export type VoicePeerState = {
  self_mute: boolean;
  self_deaf: boolean;
  screen_sharing: boolean;
};

export type VoiceTokenPayload = {
  sub: string;
  room: {
    kind: "guild" | "dm";
    guildId?: string;
    channelId: string;
  };
  exp: number;
  iat: number;
  sessionId: string;
  user: {
    id: string;
    username: string;
    display_name: string;
    avatar_url: string | null;
  };
};

export type VoiceSocketData = {
  connectionId: string;
  token: string | null;
};

export type VoiceConnection = {
  connectionId: string;
  socketId: string;
  userId: string;
  roomId: string;
  state: VoicePeerState;
  iceForwardCount: number;
  iceForwardWindowStartedAt: number;
  ws: Bun.ServerWebSocket<VoiceSocketData>;
  user: VoiceTokenPayload["user"];
};
