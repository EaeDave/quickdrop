import { useCallback, useEffect, useRef, useState } from "react";
import {
  connectRoom,
  openRoom,
  RoomAccessError,
  setTextClientBaseUrl,
  type RoomController,
  type RoomStatus,
  type TextDrop,
} from "./text-client";
import {
  copyText,
  getApiBaseUrl,
  notifyTextDrop,
  openTextClipboard,
  readClipboardText,
} from "./tauri";

const RECENT_CODES_KEY = "quickdrop.text.recent-codes";
const NOTIFICATIONS_MUTED_KEY = "quickdrop.text.notifications-muted";
const MAX_RECENT_CODES = 5;

type PanelStatus = "idle" | "opening" | RoomStatus;

export default function QuickPanel() {
  const [apiReady, setApiReady] = useState(false);
  const [joinCode, setJoinCode] = useState("");
  const [activeCode, setActiveCode] = useState<string | null>(null);
  const [status, setStatus] = useState<PanelStatus>("idle");
  const [composer, setComposer] = useState("");
  const [drops, setDrops] = useState<TextDrop[]>([]);
  const [recentCodes, setRecentCodes] = useState(readRecentCodes);
  const [notificationsMuted, setNotificationsMuted] = useState(readNotificationsMuted);
  const [message, setMessage] = useState<string | null>(null);
  const controllerRef = useRef<RoomController | null>(null);
  const clientIdRef = useRef<string | null>(null);
  const activeCodeRef = useRef<string | null>(null);
  const mutedRef = useRef(notificationsMuted);
  const clearComposerAfterSendRef = useRef(true);
  const connectRequestRef = useRef(0);

  useEffect(() => {
    let disposed = false;
    getApiBaseUrl()
      .then((baseUrl) => {
        if (disposed) return;
        setTextClientBaseUrl(baseUrl);
        setApiReady(true);
      })
      .catch((error) => setMessage(formatError(error)));
    return () => {
      disposed = true;
    };
  }, []);

  useEffect(() => {
    mutedRef.current = notificationsMuted;
    writeLocalSetting(NOTIFICATIONS_MUTED_KEY, String(notificationsMuted));
  }, [notificationsMuted]);

  useEffect(() => {
    activeCodeRef.current = activeCode;
    if (!activeCode) return;

    const controller = connectRoom(activeCode, {
      onSnapshot(payload) {
        clientIdRef.current = payload.clientId;
        setDrops(sortDrops(payload.drops));
        setMessage(null);
      },
      onDropAdded(payload) {
        setDrops((current) => sortDrops([
          payload.drop,
          ...current.filter((drop) => drop.id !== payload.drop.id),
        ]));
        if (payload.by === clientIdRef.current) {
          if (clearComposerAfterSendRef.current) setComposer("");
          clearComposerAfterSendRef.current = true;
          setMessage("Texto enviado.");
          return;
        }
        setMessage("Novo texto recebido.");
        if (
          shouldNotifyRemoteDrop(payload.by, clientIdRef.current, mutedRef.current) &&
          activeCodeRef.current
        ) {
          void notifyTextDrop(activeCodeRef.current).catch(console.error);
        }
      },
      onDropUpdated(payload) {
        setDrops((current) => sortDrops([
          payload.drop,
          ...current.filter((drop) => drop.id !== payload.drop.id),
        ]));
      },
      onDropsRemoved(payload) {
        const removed = new Set(payload.dropIds);
        setDrops((current) => current.filter((drop) => !removed.has(drop.id)));
      },
      onDropDeleted(payload) {
        setDrops((current) => current.filter((drop) => drop.id !== payload.dropId));
      },
      onDropsCleared() {
        setDrops([]);
      },
      onUpdate() {},
      onPresence() {},
      onLifecycle() {},
      onTyping() {},
      onPointer() {},
      onPeerLeft() {},
      onAck() {},
      onError(payload) {
        setMessage(payload.message);
      },
      onStatus(nextStatus) {
        setStatus(nextStatus);
      },
    });
    controllerRef.current = controller;
    return () => {
      controller.close();
      if (controllerRef.current === controller) controllerRef.current = null;
      clientIdRef.current = null;
    };
  }, [activeCode]);

  const connect = useCallback(async (requestedCode = joinCode) => {
    const code = normalizeCode(requestedCode);
    if (!apiReady || !code) return;

    const requestId = ++connectRequestRef.current;
    controllerRef.current?.close();
    setStatus("opening");
    setMessage(null);
    try {
      const opened = await openRoom(code);
      if (requestId !== connectRequestRef.current) return;
      setActiveCode(opened.code);
      setJoinCode(opened.code);
      const nextRecent = [opened.code, ...recentCodes.filter((recent) => recent !== opened.code)]
        .slice(0, MAX_RECENT_CODES);
      setRecentCodes(nextRecent);
      writeLocalSetting(RECENT_CODES_KEY, JSON.stringify(nextRecent));
    } catch (error) {
      if (requestId !== connectRequestRef.current) return;
      setStatus("idle");
      setMessage(
        error instanceof RoomAccessError && error.code === "pin_required"
          ? "Este canal usa PIN. Abra a experiência completa no navegador."
          : formatError(error),
      );
    }
  }, [apiReady, joinCode, recentCodes]);

  const disconnect = useCallback(() => {
    connectRequestRef.current += 1;
    controllerRef.current?.close();
    controllerRef.current = null;
    setActiveCode(null);
    setStatus("idle");
    setDrops([]);
    setMessage(null);
  }, []);

  const send = useCallback((content = composer, clearComposer = true) => {
    if (status !== "open" || !content.trim()) return;
    clearComposerAfterSendRef.current = clearComposer;
    controllerRef.current?.addDrop(content);
    setMessage("Enviando...");
  }, [composer, status]);

  const pasteAndSend = useCallback(async () => {
    try {
      const text = await readClipboardText();
      send(text, false);
    } catch (error) {
      setMessage(formatError(error));
    }
  }, [send]);

  const copyDrop = useCallback(async (drop: TextDrop) => {
    try {
      await copyText(drop.content);
      setMessage("Texto copiado.");
    } catch (error) {
      setMessage(formatError(error));
    }
  }, []);

  const openFullClipboard = useCallback(async (code: string) => {
    try {
      await openTextClipboard(code);
    } catch (error) {
      setMessage(formatError(error));
    }
  }, []);

  if (!activeCode) {
    return (
      <section className="quickpanel-text" aria-label="QuickPanel de texto">
        <div className="quickpanel-code-row">
          <input
            className="quickpanel-input"
            aria-label="Código do canal"
            autoComplete="off"
            maxLength={16}
            placeholder="Canal: DEV, A, 42..."
            value={joinCode}
            onChange={(event) => setJoinCode(normalizeCode(event.currentTarget.value))}
            onKeyDown={(event) => {
              if (event.key === "Enter") void connect();
            }}
          />
          <button className="quickpanel-primary" type="button" disabled={!apiReady || status === "opening" || !joinCode} onClick={() => void connect()}>
            {status === "opening" ? "Abrindo" : "Conectar"}
          </button>
          <button className="quickpanel-open" type="button" disabled={!joinCode} title="Abrir no navegador" aria-label="Abrir canal no navegador" onClick={() => void openFullClipboard(joinCode)}>↗</button>
        </div>
        {recentCodes.length > 0 && (
          <div className="quickpanel-recents">
            <span>Recentes</span>
            {recentCodes.map((code) => (
              <button type="button" key={code} onClick={() => void connect(code)}>{code}</button>
            ))}
          </div>
        )}
        <div className="quickpanel-empty">
          <strong>Texto entre máquinas</strong>
          <span>Conecte a um canal para enviar, esperar e receber snippets.</span>
        </div>
        {message && <p className="quickpanel-message" role="status">{message}</p>}
      </section>
    );
  }

  const connected = status === "open";
  return (
    <section className="quickpanel-text" aria-label={`Canal ${activeCode}`}>
      <div className="quickpanel-channel-row">
        <div>
          <strong>{activeCode}</strong>
          <span className={`quickpanel-status quickpanel-status--${status}`}>{statusLabel(status)}</span>
        </div>
        <div className="quickpanel-channel-actions">
          <button type="button" title={notificationsMuted ? "Ativar notificações" : "Silenciar notificações"} aria-label={notificationsMuted ? "Ativar notificações" : "Silenciar notificações"} onClick={() => setNotificationsMuted((muted) => !muted)}>
            {notificationsMuted ? "🔕" : "🔔"}
          </button>
          <button type="button" title="Abrir no navegador" onClick={() => void openFullClipboard(activeCode)}>↗</button>
          <button type="button" title="Sair do canal" onClick={disconnect}>×</button>
        </div>
      </div>

      <div className="quickpanel-composer-row">
        <textarea
          className="quickpanel-composer"
          aria-label="Texto para enviar"
          placeholder={connected ? "Digite ou cole um texto..." : "Aguardando conexão..."}
          value={composer}
          disabled={!connected}
          onChange={(event) => setComposer(event.currentTarget.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
              event.preventDefault();
              send();
            }
          }}
        />
        <button className="quickpanel-primary" type="button" disabled={!connected || !composer.trim()} onClick={() => send()}>Enviar</button>
      </div>
      <button className="quickpanel-paste" type="button" disabled={!connected} onClick={() => void pasteAndSend()}>
        Colar e enviar
      </button>

      <div className="quickpanel-drops" aria-live="polite">
        {drops.length === 0 ? (
          <p className="quickpanel-waiting">Esperando texto neste canal…</p>
        ) : drops.slice(0, 3).map((drop) => (
          <button className="quickpanel-drop" type="button" key={drop.id} title="Copiar texto" onClick={() => void copyDrop(drop)}>
            <span>{preview(drop.content)}</span>
            <small>Copiar</small>
          </button>
        ))}
      </div>
      {message && <p className="quickpanel-message" role="status">{message}</p>}
    </section>
  );
}

export function shouldNotifyRemoteDrop(
  senderId: string,
  clientId: string | null,
  muted: boolean,
): boolean {
  return clientId !== null && senderId !== clientId && !muted;
}

function normalizeCode(value: string): string {
  return value.toUpperCase().replace(/[^A-Z0-9_-]/g, "").slice(0, 16);
}

function sortDrops(drops: TextDrop[]): TextDrop[] {
  return [...drops].sort((left, right) => Date.parse(right.createdAt) - Date.parse(left.createdAt));
}

function preview(content: string): string {
  return content.replace(/\s+/g, " ").trim().slice(0, 90) || "Texto vazio";
}

function readNotificationsMuted(): boolean {
  try {
    return localStorage.getItem(NOTIFICATIONS_MUTED_KEY) === "true";
  } catch {
    return false;
  }
}

function writeLocalSetting(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    // Local preferences are best-effort and never block text transfers.
  }
}

function readRecentCodes(): string[] {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(RECENT_CODES_KEY) ?? "[]");
    return Array.isArray(value)
      ? value.filter((code): code is string => typeof code === "string" && code.length > 0 && normalizeCode(code) === code).slice(0, MAX_RECENT_CODES)
      : [];
  } catch {
    return [];
  }
}

function statusLabel(status: PanelStatus): string {
  if (status === "open") return "Conectado";
  if (status === "connecting") return "Reconectando";
  if (status === "closed") return "Desconectado";
  return "Conectando";
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
