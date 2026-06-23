import { normalizeSessionCode } from "./ids";

export type SessionClient = {
  id: string;
  send: (data: string) => void;
  close: (code?: number, reason?: string) => void;
};

type HubRoom = {
  code: string;
  clients: Map<string, SessionClient>;
};

export type TextSessionHubOptions = {
  maxClientsPerSession: number;
};

export type JoinResult =
  | { ok: true; clientCount: number }
  | { ok: false; reason: "full" };

export class TextSessionHub {
  private readonly rooms = new Map<string, HubRoom>();
  private readonly maxClientsPerSession: number;

  constructor(options: TextSessionHubOptions) {
    this.maxClientsPerSession = options.maxClientsPerSession;
  }

  join(code: string, client: SessionClient): JoinResult {
    const normalized = normalizeSessionCode(code);
    const room = this.rooms.get(normalized) ?? { code: normalized, clients: new Map<string, SessionClient>() };

    if (room.clients.size >= this.maxClientsPerSession) {
      return { ok: false, reason: "full" };
    }

    room.clients.set(client.id, client);
    this.rooms.set(normalized, room);
    return { ok: true, clientCount: room.clients.size };
  }

  leave(code: string, clientId: string): number {
    const room = this.rooms.get(normalizeSessionCode(code));

    if (!room) {
      return 0;
    }

    room.clients.delete(clientId);
    if (room.clients.size === 0) {
      this.rooms.delete(room.code);
      return 0;
    }

    return room.clients.size;
  }

  clientCount(code: string): number {
    return this.rooms.get(normalizeSessionCode(code))?.clients.size ?? 0;
  }

  broadcast(code: string, data: string, exceptId?: string): void {
    const room = this.rooms.get(normalizeSessionCode(code));

    if (!room) {
      return;
    }

    for (const client of room.clients.values()) {
      if (client.id === exceptId) {
        continue;
      }

      try {
        client.send(data);
      } catch {
        // A failing client must not break delivery to the rest of the room.
      }
    }
  }
}
