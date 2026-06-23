import { generateSessionCode, normalizeSessionCode } from "./ids";

export type SessionClient = {
  id: string;
  send: (data: string) => void;
  close: (code?: number, reason?: string) => void;
};

export type TextSession = {
  code: string;
  text: string;
  version: number;
  updatedAt: number;
  clients: Map<string, SessionClient>;
};

export type TextSessionStoreOptions = {
  maxBytes: number;
  maxSessions: number;
  maxClientsPerSession: number;
  codeLength: number;
  generateCode?: (length: number) => string;
  now?: () => number;
};

export type CreateResult =
  | { ok: true; session: TextSession }
  | { ok: false; reason: "limit" };

export type JoinResult =
  | { ok: true; text: string; version: number }
  | { ok: false; reason: "not_found" | "full" };

export type WriteResult =
  | { ok: true; version: number }
  | { ok: false; reason: "not_found" | "too_large" };

const CODE_GENERATION_ATTEMPTS = 8;

export class TextSessionStore {
  private readonly sessions = new Map<string, TextSession>();
  private readonly maxBytes: number;
  private readonly maxSessions: number;
  private readonly maxClientsPerSession: number;
  private readonly codeLength: number;
  private readonly generateCode: (length: number) => string;
  private readonly now: () => number;

  constructor(options: TextSessionStoreOptions) {
    this.maxBytes = options.maxBytes;
    this.maxSessions = options.maxSessions;
    this.maxClientsPerSession = options.maxClientsPerSession;
    this.codeLength = options.codeLength;
    this.generateCode = options.generateCode ?? generateSessionCode;
    this.now = options.now ?? Date.now;
  }

  get size(): number {
    return this.sessions.size;
  }

  createSession(): CreateResult {
    if (this.sessions.size >= this.maxSessions) {
      return { ok: false, reason: "limit" };
    }

    for (let attempt = 0; attempt < CODE_GENERATION_ATTEMPTS; attempt += 1) {
      const code = normalizeSessionCode(this.generateCode(this.codeLength));

      if (!this.sessions.has(code)) {
        const session: TextSession = {
          code,
          text: "",
          version: 0,
          updatedAt: this.now(),
          clients: new Map(),
        };
        this.sessions.set(code, session);
        return { ok: true, session };
      }
    }

    return { ok: false, reason: "limit" };
  }

  getSession(code: string): TextSession | undefined {
    return this.sessions.get(normalizeSessionCode(code));
  }

  join(code: string, client: SessionClient): JoinResult {
    const session = this.getSession(code);

    if (!session) {
      return { ok: false, reason: "not_found" };
    }

    if (session.clients.size >= this.maxClientsPerSession) {
      return { ok: false, reason: "full" };
    }

    session.clients.set(client.id, client);
    session.updatedAt = this.now();

    return { ok: true, text: session.text, version: session.version };
  }

  leave(code: string, clientId: string): void {
    const session = this.getSession(code);

    if (!session) {
      return;
    }

    session.clients.delete(clientId);
    session.updatedAt = this.now();
  }

  applyWrite(code: string, text: string): WriteResult {
    const session = this.getSession(code);

    if (!session) {
      return { ok: false, reason: "not_found" };
    }

    if (Buffer.byteLength(text, "utf8") > this.maxBytes) {
      return { ok: false, reason: "too_large" };
    }

    session.text = text;
    session.version += 1;
    session.updatedAt = this.now();

    return { ok: true, version: session.version };
  }

  broadcast(session: TextSession, data: string, exceptId?: string): void {
    for (const client of session.clients.values()) {
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

  sweepExpired(ttlMs: number): number {
    const now = this.now();
    let removed = 0;

    for (const [code, session] of this.sessions) {
      if (session.clients.size === 0 && now - session.updatedAt > ttlMs) {
        this.sessions.delete(code);
        removed += 1;
      }
    }

    return removed;
  }
}
