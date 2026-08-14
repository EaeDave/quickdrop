import { useCallback, useEffect, useRef, useState } from "react";
import {
  connectRoom,
  formatRoomExpiry,
  formatRoomPresence,
  openRoom,
  RoomAccessError,
  setTextClientBaseUrl,
  type RoomController,
  type RoomLifecycle,
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
  const [joinPin, setJoinPin] = useState("");
  const [showPin, setShowPin] = useState(false);
  const [activeCode, setActiveCode] = useState<string | null>(null);
  const [status, setStatus] = useState<PanelStatus>("idle");
  const [snapshotReady, setSnapshotReady] = useState(false);
  const [composer, setComposer] = useState("");
  const [drops, setDrops] = useState<TextDrop[]>([]);
  const [recentCodes, setRecentCodes] = useState(readRecentCodes);
  const [notificationsMuted, setNotificationsMuted] = useState(readNotificationsMuted);
  const [message, setMessage] = useState<string | null>(null);
  const [lifecycle, setLifecycle] = useState<RoomLifecycle | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const controllerRef = useRef<RoomController | null>(null);
  const accessTokenRef = useRef<string | null>(null);
  const pinInputRef = useRef<HTMLInputElement | null>(null);
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
        setSnapshotReady(true);
        clientIdRef.current = payload.clientId;
        setDrops(sortDrops(payload.drops));
        setLifecycle(roomLifecycle(payload));
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
          setMessage("Text sent.");
          return;
        }
        setMessage("New text received.");
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
        setMessage("Deleted.");
      },
      onDropsCleared() {
        setDrops([]);
      },
      onUpdate() {},
      onPresence(payload) {
        setLifecycle((current) => current ? { ...current, presence: payload.count } : current);
      },
      onLifecycle(payload) {
        setLifecycle(payload);
      },
      onTyping() {},
      onPointer() {},
      onPeerLeft() {},
      onAck() {},
      onError(payload) {
        setMessage(payload.message);
        if (payload.code === "pin_required" || payload.code === "pin_invalid" || payload.code === "invalid_token") {
          controllerRef.current?.close();
          setActiveCode(null);
          setStatus("idle");
          setSnapshotReady(false);
          setDrops([]);
          setLifecycle(null);
          setShowPin(true);
          window.setTimeout(() => pinInputRef.current?.focus(), 0);
        }
      },
      onStatus(nextStatus) {
        setStatus(nextStatus);
        if (nextStatus !== "open") setSnapshotReady(false);
      },
    }, accessTokenRef.current);
    controllerRef.current = controller;
    return () => {
      controller.close();
      if (controllerRef.current === controller) controllerRef.current = null;
      clientIdRef.current = null;
    };
  }, [activeCode]);

  useEffect(() => {
    if (!lifecycle?.expiresAt || lifecycle.presence > 0) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [lifecycle?.expiresAt, lifecycle?.presence]);

  const connect = useCallback(async (requestedCode = joinCode) => {
    const code = normalizeCode(requestedCode);
    const normalizedPin = joinPin.trim();
    if (!apiReady || !code || (showPin && !isPinReady(joinPin))) return;

    const requestId = ++connectRequestRef.current;
    controllerRef.current?.close();
    setSnapshotReady(false);
    setStatus("opening");
    setMessage(null);
    try {
      const opened = await openRoom(code, showPin ? normalizedPin : undefined);
      if (requestId !== connectRequestRef.current) return;
      accessTokenRef.current = opened.accessToken;
      setLifecycle(roomLifecycle(opened));
      setActiveCode(opened.code);
      setJoinCode(opened.code);
      setJoinPin("");
      setShowPin(false);
      const nextRecent = [opened.code, ...recentCodes.filter((recent) => recent !== opened.code)]
        .slice(0, MAX_RECENT_CODES);
      setRecentCodes(nextRecent);
      writeLocalSetting(RECENT_CODES_KEY, JSON.stringify(nextRecent));
    } catch (error) {
      if (requestId !== connectRequestRef.current) return;
      setStatus("idle");
      setMessage(
        error instanceof RoomAccessError && error.code === "pin_required"
          ? "PIN required."
          : formatError(error),
      );
      if (error instanceof RoomAccessError && (error.code === "pin_required" || error.code === "pin_invalid")) {
        setShowPin(true);
        if (error.code === "pin_invalid") setJoinPin("");
        window.setTimeout(() => pinInputRef.current?.focus(), 0);
      }
    }
  }, [apiReady, joinCode, joinPin, recentCodes, showPin]);

  const disconnect = useCallback(() => {
    connectRequestRef.current += 1;
    controllerRef.current?.close();
    controllerRef.current = null;
    setActiveCode(null);
    setStatus("idle");
    setSnapshotReady(false);
    setDrops([]);
    accessTokenRef.current = null;
    setLifecycle(null);
    setMessage(null);
  }, []);

  const send = useCallback((content = composer, clearComposer = true) => {
    if (!isRoomWritable(status, snapshotReady) || !content.trim()) return;
    clearComposerAfterSendRef.current = clearComposer;
    controllerRef.current?.addDrop(content);
    setMessage("Sending…");
  }, [composer, snapshotReady, status]);

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
      setMessage("Text copied.");
    } catch (error) {
      setMessage(formatError(error));
    }
  }, []);

  const deleteDrop = useCallback((drop: TextDrop) => {
    if (!isRoomWritable(status, snapshotReady)) return;
    controllerRef.current?.deleteDrop(drop.id);
    setMessage("Deleting…");
  }, [snapshotReady, status]);

  const openFullClipboard = useCallback(async (code: string) => {
    try {
      await openTextClipboard(code);
    } catch (error) {
      setMessage(formatError(error));
    }
  }, []);

  if (!activeCode) {
    return (
      <section className="quickpanel-text" aria-label="Text QuickPanel">
        <div className="quickpanel-code-row">
          <input
            className="quickpanel-input"
            aria-label="Room code"
            autoComplete="off"
            maxLength={16}
            placeholder="Room: DEV, A, 42…"
            value={joinCode}
            onChange={(event) => setJoinCode(normalizeCode(event.currentTarget.value))}
            onKeyDown={(event) => {
              if (event.key === "Enter") void connect();
            }}
          />
          <button className="quickpanel-primary" type="button" disabled={!apiReady || status === "opening" || !joinCode || (showPin && !isPinReady(joinPin))} onClick={() => void connect()}>
            {status === "opening" ? "Opening" : "Connect"}
          </button>
          <button className={`quickpanel-open${showPin ? " quickpanel-open--active" : ""}`} type="button" title="Use PIN" aria-label="Use PIN" aria-pressed={showPin} onClick={() => {
            if (showPin) setJoinPin("");
            setShowPin(!showPin);
          }}>PIN</button>
          <button className="quickpanel-open" type="button" disabled={!joinCode} title="Open in browser" aria-label="Open room in browser" onClick={() => void openFullClipboard(joinCode)}>↗</button>
        </div>
        {showPin && (
          <input
            ref={pinInputRef}
            className="quickpanel-input quickpanel-pin"
            aria-label="Room PIN"
            autoComplete="off"
            type="password"
            minLength={4}
            maxLength={64}
            placeholder="PIN (creates a protected room if missing)"
            value={joinPin}
            onChange={(event) => setJoinPin(event.currentTarget.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") void connect();
            }}
          />
        )}
        {recentCodes.length > 0 && (
          <div className="quickpanel-recents">
            <span>Recent</span>
            {recentCodes.map((code) => (
              <button type="button" key={code} onClick={() => void connect(code)}>{code}</button>
            ))}
          </div>
        )}
        <div className="quickpanel-empty">
          <strong>Text across devices</strong>
          <span>Connect to a room to send and receive snippets.</span>
        </div>
        {message && <p className="quickpanel-message" role="status">{message}</p>}
      </section>
    );
  }

  const connected = isRoomWritable(status, snapshotReady);
  return (
    <section className="quickpanel-text" aria-label={`Room ${activeCode}`}>
      <div className="quickpanel-channel-row">
        <div>
          <strong>{activeCode}</strong>
          <span className={`quickpanel-status quickpanel-status--${status}`}>{statusLabel(status)}</span>
          {lifecycle && <span className="quickpanel-status">· {formatRoomPresence(lifecycle.presence)} · {formatRoomExpiry(lifecycle, new Date(now), "compact")}</span>}
        </div>
        <div className="quickpanel-channel-actions">
          <button type="button" title={notificationsMuted ? "Enable notifications" : "Mute notifications"} aria-label={notificationsMuted ? "Enable notifications" : "Mute notifications"} onClick={() => setNotificationsMuted((muted) => !muted)}>
            {notificationsMuted ? "🔕" : "🔔"}
          </button>
          <button type="button" title="Open in browser" onClick={() => void openFullClipboard(activeCode)}>↗</button>
          <button type="button" title="Leave room" onClick={disconnect}>×</button>
        </div>
      </div>

      <div className="quickpanel-composer-row">
        <textarea
          className="quickpanel-composer"
          aria-label="Text to send"
          placeholder={connected ? "Type or paste text…" : "Waiting for connection…"}
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
        <button className="quickpanel-primary" type="button" disabled={!connected || !composer.trim()} onClick={() => send()}>Send</button>
      </div>
      <button className="quickpanel-paste" type="button" disabled={!connected} onClick={() => void pasteAndSend()}>
        Paste and send
      </button>

      <div className="quickpanel-drops" aria-live="polite">
        {drops.length === 0 ? (
          <p className="quickpanel-waiting">Waiting for text in this room…</p>
        ) : drops.slice(0, 3).map((drop) => (
          <div className="quickpanel-drop" key={drop.id}>
            <button className="quickpanel-drop-copy" type="button" title="Copy text" onClick={() => void copyDrop(drop)}>
              <span>{preview(drop.content)}</span>
              <small>Copy</small>
            </button>
            <button className="quickpanel-drop-delete" type="button" title="Delete" aria-label="Delete text" disabled={!connected} onClick={() => deleteDrop(drop)}>×</button>
          </div>
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

export function isPinReady(pin: string): boolean {
  return pin.trim().length >= 4;
}

export function isRoomWritable(status: PanelStatus, snapshotReady: boolean): boolean {
  return status === "open" && snapshotReady;
}

function normalizeCode(value: string): string {
  return value.toUpperCase().replace(/[^A-Z0-9_-]/g, "").slice(0, 16);
}

function sortDrops(drops: TextDrop[]): TextDrop[] {
  return [...drops].sort((left, right) => Date.parse(right.createdAt) - Date.parse(left.createdAt));
}

function preview(content: string): string {
  return content.replace(/\s+/g, " ").trim().slice(0, 90) || "Empty text";
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
  if (status === "open") return "Connected";
  if (status === "connecting") return "Reconnecting";
  if (status === "closed") return "Disconnected";
  return "Connecting";
}

function roomLifecycle(value: Pick<RoomLifecycle, "expiresAfterMinutes" | "expiresAt" | "presence">): RoomLifecycle {
  return {
    expiresAfterMinutes: value.expiresAfterMinutes,
    expiresAt: value.expiresAt,
    presence: value.presence,
  };
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
