import { type ChangeEvent, type PointerEvent as ReactPointerEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { connectRoom, createRoom, openRoom, RoomAccessError, type RoomController, type RoomErrorCode, type RoomPointer } from "./text-client";
import { uploadFiles } from "./tauri";
import { initialRoomCode, setRoomInUrl } from "./web-route";
import { UserCursor } from "./UserCursor";

type PendingRemoteUpdate = { text: string; version: number };
type ConnectionPhase = "connecting" | "open" | "closed";
type ExportState =
  | { status: "idle" }
  | { status: "uploading" }
  | { status: "success"; url: string; copied: boolean }
  | { status: "error"; message: string };
type RemotePointerState = { by: string; x: number; y: number; color: string; label: string };

const WRITE_DELAY_MS = 75;
const TYPING_IDLE_MS = 1200;
const POINTER_SEND_INTERVAL_MS = 33;
const POINTER_STALE_MS = 1500;
const POINTER_COLORS = [
  { name: "Azul", color: "#38bdf8" },
  { name: "Laranja", color: "#fb923c" },
  { name: "Verde", color: "#4ade80" },
  { name: "Rosa", color: "#f472b6" },
  { name: "Roxo", color: "#a78bfa" },
  { name: "Ciano", color: "#22d3ee" },
];

function getPeerAppearance(clientId: string): { color: string; label: string } {
  let hash = 0;
  for (let index = 0; index < clientId.length; index += 1) {
    hash = (hash * 31 + clientId.charCodeAt(index)) >>> 0;
  }

  const entry = POINTER_COLORS[hash % POINTER_COLORS.length]!;
  return { color: entry.color, label: entry.name };
}

export default function TextSession() {
  const initialCode = initialRoomCode();
  const [roomCode, setRoomCode] = useState<string | null>(null);
  const [joinCode, setJoinCode] = useState(initialCode ?? "");
  const [joinPin, setJoinPin] = useState("");
  const [pinRequired, setPinRequired] = useState(false);
  const [showPrivacyOptions, setShowPrivacyOptions] = useState(false);
  const [isJoining, setIsJoining] = useState(false);
  const [text, setText] = useState("");
  const [version, setVersion] = useState(0);
  const [clientId, setClientId] = useState<string | null>(null);
  const [connectionPhase, setConnectionPhase] = useState<ConnectionPhase>("closed");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [pendingRemote, setPendingRemote] = useState<PendingRemoteUpdate | null>(null);
  const [presenceCount, setPresenceCount] = useState<number | null>(null);
  const [remoteTypers, setRemoteTypers] = useState<string[]>([]);
  const [remotePointers, setRemotePointers] = useState<RemotePointerState[]>([]);
  const [exportState, setExportState] = useState<ExportState>({ status: "idle" });

  const controllerRef = useRef<RoomController | null>(null);
  const roomCodeRef = useRef<string | null>(null);
  const connectionPhaseRef = useRef<ConnectionPhase>("closed");
  const hasOpenedRef = useRef(false);
  const snapshotReadyRef = useRef(false);
  const debounceTimerRef = useRef<number | null>(null);
  const draftTextRef = useRef("");
  const syncedTextRef = useRef("");
  const versionRef = useRef(0);
  const clientIdRef = useRef<string | null>(null);
  const inFlightRef = useRef(false);
  const sentTextRef = useRef<string | null>(null);
  const queuedTextRef = useRef<string | null>(null);
  const leavingRoomRef = useRef(false);
  const suppressNextClosedRef = useRef(false);
  const preserveJoinContextRef = useRef(false);
  const discardNextAckRef = useRef(false);
  const autoJoinAttemptedRef = useRef(false);
  const flushAfterNextChangeRef = useRef(false);
  const lastWriteDispatchAtRef = useRef(0);
  const typingActiveRef = useRef(false);
  const typingStopTimerRef = useRef<number | null>(null);
  const pointerSendTimerRef = useRef<number | null>(null);
  const pointerPendingRef = useRef<RoomPointer | null>(null);
  const lastPointerSendAtRef = useRef(0);
  const remotePointerTimersRef = useRef(new Map<string, number>());

  const clearDebounceTimer = useCallback(() => {
    if (debounceTimerRef.current !== null) {
      window.clearTimeout(debounceTimerRef.current);
      debounceTimerRef.current = null;
    }
  }, []);

  const clearPendingWrites = useCallback(
    (preserveDiscardAck = false) => {
      clearDebounceTimer();
      inFlightRef.current = false;
      sentTextRef.current = null;
      queuedTextRef.current = null;
      discardNextAckRef.current = preserveDiscardAck;
    },
    [clearDebounceTimer],
  );

  const clearTypingStopTimer = useCallback(() => {
    if (typingStopTimerRef.current !== null) {
      window.clearTimeout(typingStopTimerRef.current);
      typingStopTimerRef.current = null;
    }
  }, []);

  const clearPointerSendTimer = useCallback(() => {
    if (pointerSendTimerRef.current !== null) {
      window.clearTimeout(pointerSendTimerRef.current);
      pointerSendTimerRef.current = null;
    }
  }, []);

  const clearRemotePointerTimer = useCallback((clientId: string) => {
    const timer = remotePointerTimersRef.current.get(clientId);
    if (timer !== undefined) {
      window.clearTimeout(timer);
      remotePointerTimersRef.current.delete(clientId);
    }
  }, []);

  const removeRemotePeerState = useCallback(
    (clientId: string) => {
      clearRemotePointerTimer(clientId);
      setRemoteTypers((current) => current.filter((entry) => entry !== clientId));
      setRemotePointers((current) => current.filter((entry) => entry.by !== clientId));
    },
    [clearRemotePointerTimer],
  );

  const sendTypingInactive = useCallback(() => {
    clearTypingStopTimer();
    if (!typingActiveRef.current) {
      return;
    }

    typingActiveRef.current = false;
    controllerRef.current?.sendTyping(false);
  }, [clearTypingStopTimer]);

  const scheduleTypingStop = useCallback(() => {
    clearTypingStopTimer();
    typingStopTimerRef.current = window.setTimeout(() => {
      typingStopTimerRef.current = null;
      sendTypingInactive();
    }, TYPING_IDLE_MS);
  }, [clearTypingStopTimer, sendTypingInactive]);

  const noteLocalTyping = useCallback(() => {
    if (!typingActiveRef.current) {
      typingActiveRef.current = true;
      controllerRef.current?.sendTyping(true);
    }

    scheduleTypingStop();
  }, [scheduleTypingStop]);

  const dispatchPointer = useCallback((pointer: RoomPointer) => {
    lastPointerSendAtRef.current = Date.now();
    controllerRef.current?.sendPointer(pointer);
  }, []);

  const hideLocalPointer = useCallback(() => {
    clearPointerSendTimer();
    pointerPendingRef.current = null;
    controllerRef.current?.sendPointer({ visible: false });
  }, [clearPointerSendTimer]);

  const resetRoomData = useCallback(() => {
    snapshotReadyRef.current = false;
    hasOpenedRef.current = false;
    clearPendingWrites(false);
    clearTypingStopTimer();
    clearPointerSendTimer();
    typingActiveRef.current = false;
    pointerPendingRef.current = null;
    for (const timer of remotePointerTimersRef.current.values()) {
      window.clearTimeout(timer);
    }
    remotePointerTimersRef.current.clear();
    setPendingRemote(null);
    setPresenceCount(null);
    setRemoteTypers([]);
    setRemotePointers([]);
    setExportState({ status: "idle" });
    setText("");
    draftTextRef.current = "";
    syncedTextRef.current = "";
    versionRef.current = 0;
    lastWriteDispatchAtRef.current = 0;
    lastPointerSendAtRef.current = 0;
    setVersion(0);
    clientIdRef.current = null;
    setClientId(null);
  }, [clearPendingWrites, clearPointerSendTimer, clearTypingStopTimer]);

  const clearRoomUrl = useCallback(() => {
    history.replaceState(history.state, "", "/t");
  }, []);

  const activateRoom = useCallback(
    (code: string) => {
      const normalized = code.trim().toUpperCase();
      if (!normalized) {
        return;
      }

      roomCodeRef.current = normalized;
      setRoomCode(normalized);
      setJoinCode(normalized);
      setJoinPin("");
      setPinRequired(false);
      setErrorMessage(null);
      setPendingRemote(null);
      setConnectionPhase("connecting");
      resetRoomData();
      setRoomInUrl(normalized);
    },
    [resetRoomData],
  );

  const copyText = useCallback(async (value: string) => {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(value);
      return;
    }

    const field = document.createElement("textarea");
    field.value = value;
    field.readOnly = true;
    field.style.position = "fixed";
    field.style.left = "-9999px";
    document.body.appendChild(field);
    field.select();
    document.execCommand("copy");
    field.remove();
  }, []);

  const handleAccessError = useCallback((error: unknown) => {
    if (error instanceof RoomAccessError) {
      if (
        error.code === "pin_required" ||
        error.code === "pin_invalid" ||
        error.code === "invalid_token"
      ) {
        setPinRequired(true);
      }
      setErrorMessage(error.message);
      return;
    }

    setErrorMessage(error instanceof Error ? error.message : "Falha ao acessar a sala");
  }, []);

  const requestRoomOpen = useCallback(
    async (code: string, pin?: string) => {
      setIsJoining(true);
      try {
        await openRoom(code, pin);
        activateRoom(code);
      } catch (error) {
        handleAccessError(error);
      } finally {
        setIsJoining(false);
      }
    },
    [activateRoom, handleAccessError],
  );

  const handleJoin = useCallback(() => {
    if (!joinCode.trim()) {
      return;
    }

    void requestRoomOpen(joinCode, joinPin);
  }, [joinCode, joinPin, requestRoomOpen]);

  const handleCreateRoom = useCallback(async () => {
    setIsJoining(true);
    try {
      const created = await createRoom(joinPin);
      activateRoom(created.code);
    } catch (error) {
      handleAccessError(error);
    } finally {
      setIsJoining(false);
    }
  }, [activateRoom, handleAccessError, joinPin]);

  const flushPendingWrite = useCallback(() => {
    if (!roomCodeRef.current || !controllerRef.current || connectionPhaseRef.current !== "open" || !snapshotReadyRef.current) {
      return;
    }

    if (inFlightRef.current) {
      return;
    }

    const nextText = queuedTextRef.current;
    if (nextText === null || nextText === syncedTextRef.current) {
      queuedTextRef.current = null;
      return;
    }

    inFlightRef.current = true;
    sentTextRef.current = nextText;
    queuedTextRef.current = null;
    lastWriteDispatchAtRef.current = Date.now();
    controllerRef.current.sendWrite(nextText, versionRef.current);
  }, []);

  const scheduleFlush = useCallback(() => {
    clearDebounceTimer();
    debounceTimerRef.current = window.setTimeout(() => {
      debounceTimerRef.current = null;
      flushPendingWrite();
    }, WRITE_DELAY_MS);
  }, [clearDebounceTimer, flushPendingWrite]);

  const leaveRoom = useCallback(() => {
    leavingRoomRef.current = true;
    sendTypingInactive();
    hideLocalPointer();
    controllerRef.current?.close();
    controllerRef.current = null;
    roomCodeRef.current = null;
    setRoomCode(null);
    clearRoomUrl();
    setJoinPin("");
    setPinRequired(false);
    resetRoomData();
    setConnectionPhase("closed");
    setPendingRemote(null);
    setErrorMessage(null);
  }, [clearRoomUrl, hideLocalPointer, resetRoomData, sendTypingInactive]);

  const handleCopyCode = useCallback(async () => {
    if (!roomCode) {
      return;
    }

    try {
      await copyText(roomCode);
      setErrorMessage(null);
    } catch {
      setErrorMessage("Não foi possível copiar o código agora.");
    }
  }, [copyText, roomCode]);

  const handleExportText = useCallback(async () => {
    if (!roomCode || text.trim().length === 0) {
      return;
    }

    setExportState({ status: "uploading" });

    try {
      const file = new File([text], `quickdrop-room-${roomCode}.txt`, { type: "text/plain" });
      const uploaded = await uploadFiles([file]);

      try {
        await copyText(uploaded.url);
        setExportState({ status: "success", url: uploaded.url, copied: true });
      } catch {
        setExportState({ status: "success", url: uploaded.url, copied: false });
      }
    } catch (error) {
      setExportState({
        status: "error",
        message: error instanceof Error ? error.message : "Falha ao enviar o texto como arquivo.",
      });
    }
  }, [copyText, roomCode, text]);

  const handleRemoteOverride = useCallback(() => {
    if (!pendingRemote) {
      return;
    }

    clearPendingWrites(true);
    setPendingRemote(null);
    setText(pendingRemote.text);
    draftTextRef.current = pendingRemote.text;
    syncedTextRef.current = pendingRemote.text;
    versionRef.current = pendingRemote.version;
    setVersion(pendingRemote.version);
  }, [clearPendingWrites, pendingRemote]);

  const handleTextChange = useCallback(
    (event: ChangeEvent<HTMLTextAreaElement>) => {
      const nextText = event.currentTarget.value;
      draftTextRef.current = nextText;
      setText(nextText);
      queuedTextRef.current = nextText;
      noteLocalTyping();

      if (flushAfterNextChangeRef.current) {
        flushAfterNextChangeRef.current = false;
        clearDebounceTimer();
        flushPendingWrite();
        return;
      }

      if (
        connectionPhaseRef.current === "open" &&
        snapshotReadyRef.current &&
        !inFlightRef.current &&
        Date.now() - lastWriteDispatchAtRef.current >= WRITE_DELAY_MS
      ) {
        clearDebounceTimer();
        flushPendingWrite();
        return;
      }

      scheduleFlush();
    },
    [clearDebounceTimer, flushPendingWrite, noteLocalTyping, scheduleFlush],
  );

  const handleTextPaste = useCallback(() => {
    flushAfterNextChangeRef.current = true;
    noteLocalTyping();
  }, [noteLocalTyping]);

  const handleTextBlur = useCallback(() => {
    clearDebounceTimer();
    flushPendingWrite();
    sendTypingInactive();
    hideLocalPointer();
  }, [clearDebounceTimer, flushPendingWrite, hideLocalPointer, sendTypingInactive]);

  const handleEditorPointerMove = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      const rect = event.currentTarget.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) {
        return;
      }

      const pointer: RoomPointer = {
        visible: true,
        x: (event.clientX - rect.left) / rect.width,
        y: (event.clientY - rect.top) / rect.height,
      };
      pointerPendingRef.current = pointer;

      const elapsed = Date.now() - lastPointerSendAtRef.current;
      if (elapsed >= POINTER_SEND_INTERVAL_MS && pointerSendTimerRef.current === null) {
        dispatchPointer(pointer);
        return;
      }

      if (pointerSendTimerRef.current !== null) {
        return;
      }

      pointerSendTimerRef.current = window.setTimeout(() => {
        pointerSendTimerRef.current = null;
        const pending = pointerPendingRef.current;
        pointerPendingRef.current = null;
        if (pending) {
          dispatchPointer(pending);
        }
      }, Math.max(0, POINTER_SEND_INTERVAL_MS - elapsed));
    },
    [dispatchPointer],
  );

  const handleEditorPointerLeave = useCallback(() => {
    hideLocalPointer();
  }, [hideLocalPointer]);

  const updateRemotePointer = useCallback(
    (clientId: string, pointer: RoomPointer) => {
      clearRemotePointerTimer(clientId);

      if (!pointer.visible) {
        setRemotePointers((current) => current.filter((entry) => entry.by !== clientId));
        return;
      }

      const x = pointer.x;
      const y = pointer.y;
      if (x === undefined || y === undefined) {
        setRemotePointers((current) => current.filter((entry) => entry.by !== clientId));
        return;
      }

      const appearance = getPeerAppearance(clientId);
      setRemotePointers((current) => {
        const next = current.filter((entry) => entry.by !== clientId);
        next.push({ by: clientId, x, y, color: appearance.color, label: appearance.label });
        return next;
      });

      const timer = window.setTimeout(() => {
        remotePointerTimersRef.current.delete(clientId);
        setRemotePointers((current) => current.filter((entry) => entry.by !== clientId));
      }, POINTER_STALE_MS);
      remotePointerTimersRef.current.set(clientId, timer);
    },
    [clearRemotePointerTimer],
  );

  useEffect(() => {
    roomCodeRef.current = roomCode;
    if (roomCode) {
      setRoomInUrl(roomCode);
    }
  }, [roomCode]);

  useEffect(() => {
    document.documentElement.classList.add("quickdrop-text-page");
    return () => document.documentElement.classList.remove("quickdrop-text-page");
  }, []);

  useEffect(() => {
    if (!initialCode || roomCode || autoJoinAttemptedRef.current) {
      return;
    }

    autoJoinAttemptedRef.current = true;
    void requestRoomOpen(initialCode, undefined);
  }, [initialCode, requestRoomOpen, roomCode]);

  useEffect(() => {
    if (!roomCode) {
      return;
    }

    const controller = connectRoom(roomCode, {
      onSnapshot(payload) {
        snapshotReadyRef.current = true;
        clearPendingWrites(false);
        hasOpenedRef.current = true;
        draftTextRef.current = payload.text;
        syncedTextRef.current = payload.text;
        versionRef.current = payload.version;
        clientIdRef.current = payload.clientId;
        setText(payload.text);
        setVersion(payload.version);
        setClientId(payload.clientId);
        setPendingRemote(null);
        setErrorMessage(null);
        flushPendingWrite();
      },
      onUpdate(payload) {
        if (payload.by === clientIdRef.current) {
          return;
        }

        const hasLocalChanges =
          draftTextRef.current !== syncedTextRef.current ||
          inFlightRef.current ||
          queuedTextRef.current !== null;
        if (!hasLocalChanges) {
          draftTextRef.current = payload.text;
          syncedTextRef.current = payload.text;
          versionRef.current = payload.version;
          setText(payload.text);
          setVersion(payload.version);
          setPendingRemote(null);
          return;
        }

        setPendingRemote({ text: payload.text, version: payload.version });
      },
      onPresence(payload) {
        setPresenceCount(payload.count);
      },
      onTyping(payload) {
        if (payload.by === clientIdRef.current) {
          return;
        }

        setRemoteTypers((current) => {
          if (payload.active) {
            return current.includes(payload.by) ? current : [...current, payload.by];
          }

          return current.filter((entry) => entry !== payload.by);
        });
      },
      onPointer(payload) {
        if (payload.by === clientIdRef.current) {
          return;
        }

        updateRemotePointer(payload.by, payload.pointer);
      },
      onPeerLeft(payload) {
        if (payload.by === clientIdRef.current) {
          return;
        }

        removeRemotePeerState(payload.by);
      },
      onAck(payload) {
        if (discardNextAckRef.current) {
          discardNextAckRef.current = false;
          return;
        }

        versionRef.current = payload.version;
        setVersion(payload.version);
        if (sentTextRef.current !== null) {
          syncedTextRef.current = sentTextRef.current;
          sentTextRef.current = null;
          inFlightRef.current = false;
        }

        flushPendingWrite();
      },
      onError(payload) {
        if (
          payload.code === "pin_required" ||
          payload.code === "pin_invalid" ||
          payload.code === "invalid_token"
        ) {
          preserveJoinContextRef.current = true;
          setPinRequired(true);
          setJoinPin("");
          setErrorMessage(payload.message);
          controllerRef.current?.close();
          return;
        }

        setErrorMessage(payload.message);
      },
      onStatus(status) {
        connectionPhaseRef.current = status;
        setConnectionPhase(status);

        if (status === "open") {
          hasOpenedRef.current = true;
          return;
        }

        clearPendingWrites(false);
        snapshotReadyRef.current = false;

        if (status === "closed") {
          if (suppressNextClosedRef.current) {
            suppressNextClosedRef.current = false;
            return;
          }

          if (leavingRoomRef.current) {
            leavingRoomRef.current = false;
            return;
          }

          controllerRef.current = null;
          if (preserveJoinContextRef.current) {
            preserveJoinContextRef.current = false;
            roomCodeRef.current = null;
            setRoomCode(null);
            resetRoomData();
            return;
          }

          if (roomCodeRef.current) {
            roomCodeRef.current = null;
            setRoomCode(null);
            clearRoomUrl();
          }
          resetRoomData();
        }
      },
    });

    controllerRef.current = controller;
    return () => {
      if (!leavingRoomRef.current) {
        suppressNextClosedRef.current = true;
      }
      sendTypingInactive();
      hideLocalPointer();
      for (const timer of remotePointerTimersRef.current.values()) {
        window.clearTimeout(timer);
      }
      remotePointerTimersRef.current.clear();
      controller.close();
      if (controllerRef.current === controller) {
        controllerRef.current = null;
      }
    };
  }, [
    clearPendingWrites,
    clearRoomUrl,
    flushPendingWrite,
    hideLocalPointer,
    initialCode,
    removeRemotePeerState,
    requestRoomOpen,
    resetRoomData,
    roomCode,
    sendTypingInactive,
    updateRemotePointer,
  ]);
  useEffect(() => {
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape" && roomCodeRef.current) {
        event.preventDefault();
        leaveRoom();
      }
    };

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [leaveRoom]);

  useEffect(() => {
    return () => {
      clearDebounceTimer();
      clearTypingStopTimer();
      clearPointerSendTimer();
      sendTypingInactive();
      hideLocalPointer();
      controllerRef.current?.close();
    };
  }, [clearDebounceTimer, clearPointerSendTimer, clearTypingStopTimer, hideLocalPointer, sendTypingInactive]);

  const badgeVariant = roomCode
    ? connectionPhase === "open"
      ? "open"
      : connectionPhase === "closed"
        ? "closed"
        : hasOpenedRef.current
          ? "reconnecting"
          : "connecting"
    : null;
  const statusLabel =
    badgeVariant === "open"
      ? "Conectado"
      : badgeVariant === "closed"
        ? "Desconectado"
        : badgeVariant === "reconnecting"
          ? "Reconectando"
          : "Conectando";
  const remoteTypingLabels = useMemo(
    () => remoteTypers.map((clientId) => getPeerAppearance(clientId).label),
    [remoteTypers],
  );
  const typingLabel =
    remoteTypingLabels.length === 0
      ? null
      : remoteTypingLabels.length === 1
        ? `${remoteTypingLabels[0]} digitando...`
        : `${remoteTypingLabels.join(", ")} digitando...`;
  const presenceLabel =
    presenceCount === null ? null : `${presenceCount} ${presenceCount === 1 ? "conectado" : "conectados"}`;
  const exportButtonLabel = exportState.status === "uploading" ? "Enviando..." : "Enviar como arquivo";
  const showExportSuccess = exportState.status === "success";
  const showExportError = exportState.status === "error";
  const pinLabel = pinRequired ? "PIN da sala" : "PIN (opcional)";
  const primaryJoinLabel = isJoining ? "Abrindo..." : "Abrir";
  const createLabel = isJoining ? "Gerando..." : "Gerar código aleatório";

  if (!roomCode) {
    return (
      <main className="quickdrop-text-shell">
        <section className="quickdrop-text-card quickdrop-text-join">
          <div className="quickdrop-text-heading">
            <p className="quickdrop-text-kicker">Texto entre máquinas</p>
            <h1>Clipboard temporário</h1>
            <p className="quickdrop-text-copy">
              Digite o mesmo código nos dois computadores. Se não existir, o QuickDrop cria na hora.
            </p>
          </div>

          {errorMessage ? <p className="quickdrop-text-note quickdrop-text-note--error">{errorMessage}</p> : null}

          <label className="quickdrop-text-field">
            <span>Digite um código</span>
            <input
              className="quickdrop-text-input"
              autoComplete="off"
              inputMode="text"
              maxLength={16}
              placeholder="Ex.: A, DEV ou SERVER-1"
              value={joinCode}
              onChange={(event) => setJoinCode(event.currentTarget.value.toUpperCase().replace(/[^A-Z0-9_-]/g, "").slice(0, 16))}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  handleJoin();
                }
              }}
            />
          </label>

          {pinRequired || showPrivacyOptions ? (
            <>
              <label className="quickdrop-text-field">
                <span>{pinLabel}</span>
                <input
                  className="quickdrop-text-input"
                  autoComplete="off"
                  inputMode="text"
                  type="password"
                  maxLength={64}
                  placeholder={pinRequired ? "Informe o PIN" : "Proteja o clipboard se quiser"}
                  value={joinPin}
                  onChange={(event) => setJoinPin(event.currentTarget.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") {
                      event.preventDefault();
                      handleJoin();
                    }
                  }}
                />
              </label>
              <button className="quickdrop-text-button" type="button" disabled={isJoining} onClick={handleCreateRoom}>
                {createLabel}
              </button>
            </>
          ) : null}

          <p className="quickdrop-text-copy">
            Códigos curtos são públicos e fáceis de adivinhar. Não use para senhas ou dados sensíveis.
          </p>

          <div className="quickdrop-text-actions">
            <button className="quickdrop-text-button quickdrop-text-button--primary" type="button" disabled={!joinCode.trim() || isJoining} onClick={handleJoin}>
              {primaryJoinLabel}
            </button>
            <button className="quickdrop-text-button" type="button" disabled={isJoining} onClick={() => setShowPrivacyOptions((current) => !current)}>
              {showPrivacyOptions ? "Ocultar privacidade" : "Opções de privacidade"}
            </button>
          </div>
        </section>
      </main>
    );
  }

  return (
    <main className="quickdrop-text-shell quickdrop-text-shell--room">
      <section className="quickdrop-text-room">
        <header className="quickdrop-text-room-header">
          <div className="quickdrop-text-room-meta">
            <button className="quickdrop-text-icon-button" type="button" onClick={leaveRoom}>
              ← Voltar
            </button>
            <div>
              <p className="quickdrop-text-kicker">Sala ativa</p>
              <div className="quickdrop-text-room-code-row">
                <h1 className="quickdrop-text-room-code">{roomCode}</h1>
                <button className="quickdrop-text-button quickdrop-text-button--ghost" type="button" onClick={handleCopyCode}>
                  Copiar código
                </button>
                <button
                  className="quickdrop-text-button"
                  type="button"
                  disabled={exportState.status === "uploading" || text.trim().length === 0}
                  onClick={handleExportText}
                >
                  {exportButtonLabel}
                </button>
              </div>
              {presenceLabel ? <p className="quickdrop-text-room-presence">{presenceLabel}</p> : null}
              {typingLabel ? <p className="quickdrop-text-room-typing">{typingLabel}</p> : null}
            </div>
          </div>

          <span className={`quickdrop-text-badge quickdrop-text-badge--${badgeVariant ?? "closed"}`}>{statusLabel}</span>
        </header>

        {showExportError ? <p className="quickdrop-text-note quickdrop-text-note--error">{exportState.message}</p> : null}
        {showExportSuccess ? (
          <p className="quickdrop-text-note quickdrop-text-note--success">
            {exportState.copied ? (
              "Texto enviado. Link copiado."
            ) : (
              <>
                Texto enviado. <a href={exportState.url} target="_blank" rel="noreferrer">Abrir link</a>
              </>
            )}
          </p>
        ) : null}
        {errorMessage ? <p className="quickdrop-text-note quickdrop-text-note--error">{errorMessage}</p> : null}
        {pendingRemote ? (
          <div className="quickdrop-text-banner">
            <p>Conteúdo atualizado em outra máquina</p>
            <button className="quickdrop-text-button quickdrop-text-button--banner" type="button" onClick={handleRemoteOverride}>
              Carregar
            </button>
          </div>
        ) : null}

        <div className="quickdrop-text-editor" onPointerMove={handleEditorPointerMove} onPointerLeave={handleEditorPointerLeave}>
          <span className="sr-only">Conteúdo da sala</span>
          <div className="quickdrop-text-pointer-layer" aria-hidden="true">
            {remotePointers.map((pointer) => (
              <UserCursor
                key={pointer.by}
                color={pointer.color}
                label={pointer.label}
                target={{ current: { x: pointer.x, y: pointer.y } }}
              />
            ))}
          </div>
          <textarea
            className="quickdrop-text-textarea"
            value={text}
            onBlur={handleTextBlur}
            onChange={handleTextChange}
            onPaste={handleTextPaste}
            spellCheck={false}
            autoCapitalize="off"
            autoCorrect="off"
            autoComplete="off"
            autoFocus
            placeholder="Digite ou cole algo aqui..."
          />
        </div>
      </section>
    </main>
  );
}
