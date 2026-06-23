export type RoomStatus = "connecting" | "open" | "closed";

export type RoomHandlers = {
  onSnapshot(payload: { text: string; version: number; clientId: string }): void;
  onUpdate(payload: { text: string; version: number; by: string }): void;
  onAck(payload: { version: number }): void;
  onError(payload: { message: string }): void;
  onStatus(status: RoomStatus): void;
};

export type RoomController = {
  sendWrite(text: string, baseVersion: number): void;
  close(): void;
};

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

export async function createRoom(): Promise<string> {
  const response = await fetch("/api/text", { method: "POST" });
  const payload = await readJsonResponse(response);

  if (!response.ok) {
    throw new Error(getErrorMessage(payload, `Falha ao criar sala (${response.status})`));
  }

  if (!payload || typeof payload !== "object" || !("code" in payload)) {
    throw new Error("Resposta inválida ao criar sala");
  }

  const code = parseString(payload.code);
  if (!code) {
    throw new Error("Resposta inválida ao criar sala");
  }

  return code.trim().toUpperCase();
}

export async function fetchSnapshot(code: string): Promise<{ text: string; version: number }> {
  const response = await fetch(`/api/text/${encodeURIComponent(code)}`);
  const payload = await readJsonResponse(response);

  if (!response.ok) {
    throw new Error(getErrorMessage(payload, `Falha ao carregar sala (${response.status})`));
  }

  if (!payload || typeof payload !== "object") {
    throw new Error("Resposta inválida ao carregar sala");
  }

  const text = "text" in payload ? parseString(payload.text) : null;
  const version = "version" in payload ? parseNumber(payload.version) : null;
  if (text === null || version === null) {
    throw new Error("Resposta inválida ao carregar sala");
  }

  return { text, version };
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
        if (text === null || version === null || clientId === null) {
          return;
        }

        readyForWrites = true;
        writeInFlight = false;
        queuedWrite = null;
        handlers.onSnapshot({ text, version, clientId });
        flushQueuedWrite();
        return;
      }

      if (payload.type === "update") {
        const text = "text" in payload ? parseString(payload.text) : null;
        const version = "version" in payload ? parseNumber(payload.version) : null;
        const by = "by" in payload ? parseString(payload.by) : null;
        if (text === null || version === null || by === null) {
          return;
        }

        handlers.onUpdate({ text, version, by });
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
        handlers.onError({ message: messageText ?? "Erro na sala" });
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
