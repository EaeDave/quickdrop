export type RoomStatus = "connecting" | "open" | "closed";
export type RoomKind = "custom" | "generated";
export type RoomErrorCode =
  | "pin_required"
  | "pin_invalid"
  | "invalid_token"
  | "not_found"
  | "too_large"
  | "room_full"
  | "invalid_code"
  | "session_limit"
  | "code_exhausted"
  | "create_failed"
  | "empty_drop"
  | "drop_not_found"
  | "operation_failed"
  | null;

export type RoomPointer = { visible: boolean; x?: number; y?: number };
export type TextDropContentType = "text" | "url" | "command" | "json";
export type TextDrop = {
  id: string;
  content: string;
  contentType: TextDropContentType;
  createdAt: string;
  expiresAt: string;
};

export type RoomHandlers = {
  onSnapshot(payload: {
    text: string;
    version: number;
    drops: TextDrop[];
    clientId: string;
    kind: RoomKind;
    expiresAfterMinutes: number;
    dropExpiresAfterMinutes: number;
    maxDrops: number;
  }): void;
  onUpdate(payload: { text: string; version: number; by: string; origin?: "drop_sync" }): void;
  onDropAdded(payload: { drop: TextDrop; by: string }): void;
  onDropsRemoved(payload: { dropIds: string[] }): void;
  onDropDeleted(payload: { dropId: string }): void;
  onDropsCleared(): void;
  onPresence(payload: { count: number }): void;
  onTyping(payload: { by: string; active: boolean }): void;
  onPointer(payload: { by: string; pointer: RoomPointer }): void;
  onPeerLeft(payload: { by: string }): void;
  onAck(payload: { version: number }): void;
  onError(payload: { code: RoomErrorCode; message: string }): void;
  onStatus(status: RoomStatus): void;
};

export type RoomController = {
  sendWrite(text: string, baseVersion: number): void;
  sendTyping(active: boolean): void;
  sendPointer(pointer: RoomPointer): void;
  addDrop(content: string): void;
  deleteDrop(dropId: string): void;
  clearDrops(): void;
  close(): void;
};

export type RoomAccess = {
  code: string;
  protected: boolean;
  accessExpiresAt: string | null;
  kind: RoomKind;
  expiresAfterMinutes: number;
};

export type OpenRoomResult = RoomAccess & { created: boolean };

export type ClientTextMetricErrorCategory =
  | "invalid_code"
  | "pin_required"
  | "pin_invalid"
  | "invalid_token"
  | "not_found"
  | "session_limit"
  | "room_full"
  | "too_large"
  | "clipboard"
  | "network"
  | "unknown";

export type ClientTextMetric =
  | { event: "screen_opened" }
  | { event: "text_copied"; roomKind?: RoomKind }
  | {
      event: "client_error";
      roomKind?: RoomKind;
      errorCategory: ClientTextMetricErrorCategory;
    };

export class RoomAccessError extends Error {
  code: RoomErrorCode;
  status: number;

  constructor(message: string, code: RoomErrorCode, status = 0) {
    super(message);
    this.name = "RoomAccessError";
    this.code = code;
    this.status = status;
  }
}

export async function recordTextMetric(metric: ClientTextMetric): Promise<void> {
  try {
    await fetch("/api/text/metrics", {
      method: "POST",
      credentials: "same-origin",
      keepalive: true,
      headers: { "content-type": "application/json" },
      body: JSON.stringify(metric),
    });
  } catch {
    // Aggregate metrics are best-effort and never affect clipboard behavior.
  }
}

async function readJsonResponse(response: Response): Promise<unknown> {
  const contentType = response.headers.get("content-type") ?? "";
  if (!contentType.includes("application/json")) {
    return null;
  }

  return response.json();
}

function getErrorMessage(payload: unknown, fallback: string): string {
  if (!payload || typeof payload !== "object") {
    return fallback;
  }

  if ("message" in payload && typeof payload.message === "string" && payload.message.trim()) {
    return payload.message;
  }

  if ("error" in payload && typeof payload.error === "string" && payload.error.trim()) {
    return payload.error;
  }

  return fallback;
}

function getErrorCode(payload: unknown): RoomErrorCode {
  if (!payload || typeof payload !== "object" || !("error" in payload)) {
    return null;
  }

  const error = payload.error;
  return typeof error === "string" ? (error as RoomErrorCode) : null;
}

function getRoomUrl(code: string): string {
  const scheme = window.location.protocol === "https:" ? "wss:" : "ws:";
  return `${scheme}//${window.location.host}/api/text/${encodeURIComponent(code)}/ws`;
}

function parseNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function parseString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function parseBoolean(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null;
}

function parseRoomKind(value: unknown): RoomKind | null {
  return value === "custom" || value === "generated" ? value : null;
}

function parseTextDrop(value: unknown): TextDrop | null {
  if (!value || typeof value !== "object") {
    return null;
  }

  const id = "id" in value ? parseString(value.id) : null;
  const content = "content" in value ? parseString(value.content) : null;
  const contentType = "contentType" in value ? value.contentType : null;
  const createdAt = "createdAt" in value ? parseString(value.createdAt) : null;
  const expiresAt = "expiresAt" in value ? parseString(value.expiresAt) : null;
  if (
    !id ||
    content === null ||
    (contentType !== "text" && contentType !== "url" && contentType !== "command" && contentType !== "json") ||
    !createdAt ||
    !expiresAt
  ) {
    return null;
  }

  return { id, content, contentType, createdAt, expiresAt };
}

function createJsonRequest(body: Record<string, unknown> | null): RequestInit {
  if (!body) {
    return { method: "POST", credentials: "same-origin" };
  }

  return {
    method: "POST",
    credentials: "same-origin",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  };
}

export async function createRoom(pin?: string): Promise<RoomAccess> {
  const trimmedPin = pin?.trim();
  const response = await fetch(
    "/api/text",
    createJsonRequest(trimmedPin ? { pin: trimmedPin } : null),
  );
  const payload = await readJsonResponse(response);

  if (!response.ok) {
    throw new RoomAccessError(
      getErrorMessage(payload, `Falha ao criar sala (${response.status})`),
      getErrorCode(payload),
      response.status,
    );
  }

  if (!payload || typeof payload !== "object") {
    throw new RoomAccessError("Resposta inválida ao criar sala", null, response.status);
  }

  const code = "code" in payload ? parseString(payload.code) : null;
  const protectedRoom = "protected" in payload ? parseBoolean(payload.protected) : null;
  const kind = "kind" in payload ? parseRoomKind(payload.kind) : null;
  const expiresAfterMinutes = "expiresAfterMinutes" in payload ? parseNumber(payload.expiresAfterMinutes) : null;
  if (!code || protectedRoom === null || kind === null || expiresAfterMinutes === null) {
    throw new RoomAccessError("Resposta inválida ao criar sala", null, response.status);
  }

  return { code: code.trim().toUpperCase(), protected: protectedRoom, accessExpiresAt: null, kind, expiresAfterMinutes };
}

export async function openRoom(code: string, pin?: string): Promise<OpenRoomResult> {
  const normalizedCode = code.trim().toUpperCase();
  const trimmedPin = pin?.trim();
  const response = await fetch(
    `/api/text/${encodeURIComponent(normalizedCode)}/open`,
    createJsonRequest(trimmedPin ? { pin: trimmedPin } : null),
  );
  const payload = await readJsonResponse(response);

  if (!response.ok) {
    throw new RoomAccessError(
      getErrorMessage(payload, `Falha ao abrir clipboard (${response.status})`),
      getErrorCode(payload),
      response.status,
    );
  }

  if (!payload || typeof payload !== "object") {
    throw new RoomAccessError("Resposta inválida ao abrir clipboard", null, response.status);
  }

  const returnedCode = "code" in payload ? parseString(payload.code) : null;
  const protectedRoom = "protected" in payload ? parseBoolean(payload.protected) : null;
  const created = "created" in payload ? parseBoolean(payload.created) : null;
  const accessExpiresAt = "accessExpiresAt" in payload ? parseString(payload.accessExpiresAt) : null;
  const kind = "kind" in payload ? parseRoomKind(payload.kind) : null;
  const expiresAfterMinutes = "expiresAfterMinutes" in payload ? parseNumber(payload.expiresAfterMinutes) : null;
  if (!returnedCode || protectedRoom === null || created === null || kind === null || expiresAfterMinutes === null) {
    throw new RoomAccessError("Resposta inválida ao abrir clipboard", null, response.status);
  }

  return {
    code: returnedCode.trim().toUpperCase(),
    protected: protectedRoom,
    created,
    accessExpiresAt,
    kind,
    expiresAfterMinutes,
  };
}

export async function joinRoom(code: string, pin?: string): Promise<RoomAccess> {
  const trimmedPin = pin?.trim();
  const response = await fetch(
    `/api/text/${encodeURIComponent(code)}/access`,
    createJsonRequest(trimmedPin ? { pin: trimmedPin } : null),
  );
  const payload = await readJsonResponse(response);

  if (!response.ok) {
    throw new RoomAccessError(
      getErrorMessage(payload, `Falha ao entrar na sala (${response.status})`),
      getErrorCode(payload),
      response.status,
    );
  }

  if (!payload || typeof payload !== "object") {
    throw new RoomAccessError("Resposta inválida ao entrar na sala", null, response.status);
  }

  const protectedRoom = "protected" in payload ? parseBoolean(payload.protected) : null;
  const accessExpiresAt = "accessExpiresAt" in payload ? parseString(payload.accessExpiresAt) : null;
  const kind = "kind" in payload ? parseRoomKind(payload.kind) : null;
  const expiresAfterMinutes = "expiresAfterMinutes" in payload ? parseNumber(payload.expiresAfterMinutes) : null;
  if (protectedRoom === null || kind === null || expiresAfterMinutes === null) {
    throw new RoomAccessError("Resposta inválida ao entrar na sala", null, response.status);
  }

  return {
    code: code.trim().toUpperCase(),
    protected: protectedRoom,
    accessExpiresAt,
    kind,
    expiresAfterMinutes,
  };
}

export async function fetchSnapshot(code: string): Promise<{ text: string; version: number; protected: boolean; kind: RoomKind; expiresAfterMinutes: number }> {
  const response = await fetch(`/api/text/${encodeURIComponent(code)}`, { credentials: "same-origin" });
  const payload = await readJsonResponse(response);

  if (!response.ok) {
    throw new RoomAccessError(
      getErrorMessage(payload, `Falha ao carregar sala (${response.status})`),
      getErrorCode(payload),
      response.status,
    );
  }

  if (!payload || typeof payload !== "object") {
    throw new RoomAccessError("Resposta inválida ao carregar sala", null, response.status);
  }

  const text = "text" in payload ? parseString(payload.text) : null;
  const version = "version" in payload ? parseNumber(payload.version) : null;
  const protectedRoom = "protected" in payload ? parseBoolean(payload.protected) : null;
  const kind = "kind" in payload ? parseRoomKind(payload.kind) : null;
  const expiresAfterMinutes = "expiresAfterMinutes" in payload ? parseNumber(payload.expiresAfterMinutes) : null;
  if (text === null || version === null || protectedRoom === null || kind === null || expiresAfterMinutes === null) {
    throw new RoomAccessError("Resposta inválida ao carregar sala", null, response.status);
  }

  return { text, version, protected: protectedRoom, kind, expiresAfterMinutes };
}

export function connectRoom(code: string, handlers: RoomHandlers): RoomController {
  let socket: WebSocket | null = null;
  let reconnectTimer: number | null = null;
  let closedByUser = false;
  let fatalClose = false;
  let reconnectDelayMs = 1000;
  let readyForWrites = false;
  let queuedWrite: { text: string; baseVersion: number } | null = null;
  let writeInFlight = false;

  const clearReconnectTimer = () => {
    if (reconnectTimer !== null) {
      window.clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
  };

  const flushQueuedWrite = () => {
    if (!socket || socket.readyState !== WebSocket.OPEN || !readyForWrites || writeInFlight || queuedWrite === null) {
      return;
    }

    const payload = queuedWrite;
    queuedWrite = null;
    writeInFlight = true;

    try {
      socket.send(JSON.stringify({ type: "write", text: payload.text, baseVersion: payload.baseVersion }));
    } catch {
      queuedWrite = null;
      writeInFlight = false;
      scheduleReconnect();
    }
  };

  const sendRealtimeAction = (payload: Record<string, unknown>) => {
    if (!socket || socket.readyState !== WebSocket.OPEN || !readyForWrites || closedByUser || fatalClose) {
      return;
    }

    try {
      socket.send(JSON.stringify(payload));
    } catch {
      scheduleReconnect();
    }
  };

  const openSocket = () => {
    if (closedByUser || fatalClose) {
      return;
    }

    handlers.onStatus("connecting");
    readyForWrites = false;

    try {
      socket = new WebSocket(getRoomUrl(code));
    } catch {
      scheduleReconnect();
      return;
    }

    socket.onopen = () => {
      if (closedByUser || fatalClose) {
        return;
      }

      reconnectDelayMs = 1000;
      handlers.onStatus("open");
    };

    socket.onmessage = (event) => {
      const message = typeof event.data === "string" ? event.data : "";
      let payload: unknown;

      try {
        payload = JSON.parse(message);
      } catch {
        return;
      }

      if (!payload || typeof payload !== "object" || !("type" in payload)) {
        return;
      }

      if (payload.type === "snapshot") {
        const text = "text" in payload ? parseString(payload.text) : null;
        const version = "version" in payload ? parseNumber(payload.version) : null;
        const clientId = "clientId" in payload ? parseString(payload.clientId) : null;
        const kind = "kind" in payload ? parseRoomKind(payload.kind) : null;
        const expiresAfterMinutes = "expiresAfterMinutes" in payload ? parseNumber(payload.expiresAfterMinutes) : null;
        const dropExpiresAfterMinutes = "dropExpiresAfterMinutes" in payload ? parseNumber(payload.dropExpiresAfterMinutes) : expiresAfterMinutes;
        const maxDrops = "maxDrops" in payload ? parseNumber(payload.maxDrops) : 10;
        const rawDrops = "drops" in payload && Array.isArray(payload.drops) ? payload.drops : [];
        const drops = rawDrops.map(parseTextDrop);
        if (text === null || version === null || clientId === null || kind === null || expiresAfterMinutes === null) {
          return;
        }
        if (dropExpiresAfterMinutes === null || maxDrops === null || drops.some((drop) => drop === null)) {
          return;
        }

        readyForWrites = true;
        writeInFlight = false;
        queuedWrite = null;
        handlers.onSnapshot({
          text,
          version,
          drops: drops as TextDrop[],
          clientId,
          kind,
          expiresAfterMinutes,
          dropExpiresAfterMinutes,
          maxDrops,
        });
        flushQueuedWrite();
        return;
      }

      if (payload.type === "update") {
        const text = "text" in payload ? parseString(payload.text) : null;
        const version = "version" in payload ? parseNumber(payload.version) : null;
        const by = "by" in payload ? parseString(payload.by) : null;
        const origin = "origin" in payload && payload.origin === "drop_sync" ? payload.origin : undefined;
        if (text === null || version === null || by === null) {
          return;
        }

        handlers.onUpdate({ text, version, by, ...(origin ? { origin } : {}) });
        return;
      }

      if (payload.type === "drop_added") {
        const drop = "drop" in payload ? parseTextDrop(payload.drop) : null;
        const by = "by" in payload ? parseString(payload.by) : null;
        if (!drop || !by) {
          return;
        }
        handlers.onDropAdded({ drop, by });
        return;
      }

      if (payload.type === "drops_removed") {
        const dropIds = "dropIds" in payload && Array.isArray(payload.dropIds)
          ? payload.dropIds.filter((id): id is string => typeof id === "string")
          : null;
        if (!dropIds) {
          return;
        }
        handlers.onDropsRemoved({ dropIds });
        return;
      }

      if (payload.type === "drop_deleted") {
        const dropId = "dropId" in payload ? parseString(payload.dropId) : null;
        if (!dropId) {
          return;
        }
        handlers.onDropDeleted({ dropId });
        return;
      }

      if (payload.type === "drops_cleared") {
        handlers.onDropsCleared();
        return;
      }

      if (payload.type === "presence") {
        const count = "count" in payload ? parseNumber(payload.count) : null;
        if (count === null) {
          return;
        }

        handlers.onPresence({ count });
        return;
      }

      if (payload.type === "typing") {
        const by = "by" in payload ? parseString(payload.by) : null;
        const active = "active" in payload && typeof payload.active === "boolean" ? payload.active : null;
        if (by === null || active === null) {
          return;
        }

        handlers.onTyping({ by, active });
        return;
      }

      if (payload.type === "pointer") {
        const by = "by" in payload ? parseString(payload.by) : null;
        const visible = "visible" in payload && typeof payload.visible === "boolean" ? payload.visible : null;
        if (by === null || visible === null) {
          return;
        }

        if (!visible) {
          handlers.onPointer({ by, pointer: { visible: false } });
          return;
        }

        const x = "x" in payload ? parseNumber(payload.x) : null;
        const y = "y" in payload ? parseNumber(payload.y) : null;
        if (x === null || y === null) {
          return;
        }

        handlers.onPointer({ by, pointer: { visible: true, x, y } });
        return;
      }

      if (payload.type === "peer_left") {
        const by = "by" in payload ? parseString(payload.by) : null;
        if (by === null) {
          return;
        }

        handlers.onPeerLeft({ by });
        return;
      }


      if (payload.type === "ack") {
        const version = "version" in payload ? parseNumber(payload.version) : null;
        if (version === null) {
          return;
        }

        writeInFlight = false;
        handlers.onAck({ version });
        flushQueuedWrite();
        return;
      }

      if (payload.type === "error") {
        const messageText = "message" in payload ? parseString(payload.message) : null;
        const code = "error" in payload ? parseString(payload.error) : null;
        handlers.onError({ code: code as RoomErrorCode, message: messageText ?? "Erro na sala" });
      }
    };

    socket.onerror = () => {
      // The close handler decides whether to reconnect.
    };

    socket.onclose = (event) => {
      socket = null;
      readyForWrites = false;
      writeInFlight = false;
      queuedWrite = null;

      if (closedByUser) {
        clearReconnectTimer();
        handlers.onStatus("closed");
        return;
      }

      if (event.code === 1008) {
        fatalClose = true;
        clearReconnectTimer();
        handlers.onStatus("closed");
        return;
      }

      scheduleReconnect();
    };
  };

  const scheduleReconnect = () => {
    if (closedByUser || fatalClose) {
      return;
    }

    clearReconnectTimer();
    handlers.onStatus("connecting");
    reconnectTimer = window.setTimeout(() => {
      reconnectTimer = null;
      openSocket();
    }, reconnectDelayMs);
    reconnectDelayMs = Math.min(reconnectDelayMs * 2, 10000);
  };

  openSocket();

  return {
    sendWrite(text: string, baseVersion: number) {
      if (closedByUser || fatalClose) {
        return;
      }

      queuedWrite = { text, baseVersion };
      flushQueuedWrite();
    },
    sendTyping(active: boolean) {
      if (!socket || socket.readyState !== WebSocket.OPEN || closedByUser || fatalClose) {
        return;
      }

      try {
        socket.send(JSON.stringify({ type: "typing", active }));
      } catch {
        scheduleReconnect();
      }
    },
    sendPointer(pointer: RoomPointer) {
      if (!socket || socket.readyState !== WebSocket.OPEN || closedByUser || fatalClose) {
        return;
      }

      try {
        socket.send(JSON.stringify({ type: "pointer", ...pointer }));
      } catch {
        scheduleReconnect();
      }
    },
    addDrop(content: string) {
      sendRealtimeAction({ type: "drop_add", content });
    },
    deleteDrop(dropId: string) {
      sendRealtimeAction({ type: "drop_delete", dropId });
    },
    clearDrops() {
      sendRealtimeAction({ type: "drops_clear" });
    },
    close() {
      if (closedByUser) {
        return;
      }

      closedByUser = true;
      clearReconnectTimer();
      queuedWrite = null;
      writeInFlight = false;
      readyForWrites = false;

      if (socket) {
        try {
          socket.close();
        } catch {
          handlers.onStatus("closed");
        }
      } else {
        handlers.onStatus("closed");
      }
    },
  };
}
