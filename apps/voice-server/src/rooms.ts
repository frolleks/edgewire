import type { VoiceConnection } from "./types";

const connectionsBySocketId = new Map<string, VoiceConnection>();
const roomMembers = new Map<string, Set<string>>();

export const registerConnection = (connection: VoiceConnection): void => {
  connectionsBySocketId.set(connection.socketId, connection);
  const currentRoom = roomMembers.get(connection.roomId) ?? new Set<string>();
  currentRoom.add(connection.socketId);
  roomMembers.set(connection.roomId, currentRoom);
};

export const removeConnection = (socketId: string): VoiceConnection | null => {
  const connection = connectionsBySocketId.get(socketId);
  if (!connection) {
    return null;
  }

  connectionsBySocketId.delete(socketId);
  const room = roomMembers.get(connection.roomId);
  if (room) {
    room.delete(socketId);
    if (room.size === 0) {
      roomMembers.delete(connection.roomId);
    }
  }

  return connection;
};

export const getConnectionBySocketId = (socketId: string): VoiceConnection | null =>
  connectionsBySocketId.get(socketId) ?? null;

export const listRoomConnections = (roomId: string): VoiceConnection[] => {
  const socketIds = roomMembers.get(roomId);
  if (!socketIds) {
    return [];
  }

  const result: VoiceConnection[] = [];
  for (const socketId of socketIds) {
    const connection = connectionsBySocketId.get(socketId);
    if (connection) {
      result.push(connection);
    }
  }
  return result;
};
