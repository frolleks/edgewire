export interface UserSummary {
  id: string;
  username: string;
  display_name: string;
  avatar_url: string | null;
}

export interface MessagePayload {
  id: string;
  channel_id: string;
  author: UserSummary;
  content: string;
  timestamp: string;
  edited_timestamp: string | null;
  type: 0;
}

export interface DmChannelPayload {
  id: string;
  type: 1;
  recipients: UserSummary[];
  last_message_id: string | null;
  last_message?: MessagePayload | null;
  unread?: boolean;
}

export interface GatewayPacket<T = unknown> {
  op: number;
  d?: T;
  s?: number | null;
  t?: string | null;
}

export interface ReadyEvent {
  v: 1;
  user: UserSummary;
  session_id: string;
  resume_gateway_url: string;
  private_channels: DmChannelPayload[];
}

export interface TypingStartEvent {
  channel_id: string;
  user_id: string;
  timestamp: number;
}

export interface ReadStateUpdateEvent {
  channel_id: string;
  user_id: string;
  last_read_message_id: string | null;
}

export interface GatewayHello {
  heartbeat_interval: number;
}
