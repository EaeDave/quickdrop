import { type ChangeEvent, useCallback, useEffect, useRef, useState } from "react";
import { connectRoom, createRoom, openRoom, RoomAccessError, type RoomController, type RoomErrorCode, type RoomKind } from "./text-client";
import { uploadFiles } from "./tauri";
import { isCopyTextShortcut, remoteContentNotice } from "./text-session-shortcuts";
import { initialRoomCode, setRoomInUrl, textRoomPath } from "./web-route";

type PendingRemoteUpdate = { text: string; version: number };
type ConnectionPhase = "connecting" | "open" | "closed";
type ExportState =
  | { status: "idle" }
  | { status: "uploading" }
  | { status: "success"; url: string; copied: boolean }
  | { status: "error"; message: string };

const WRITE_DELAY_MS = 75;

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
  const [connectionPhase, setConnectionPhase] = useState<ConnectionPhase>("closed");
  const [snapshotReady, setSnapshotReady] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [roomNotice, setRoomNotice] = useState<string | null>(null);
  const [roomKind, setRoomKind] = useState<RoomKind | null>(null);
  const [expiresAfterMinutes, setExpiresAfterMinutes] = useState<number | null>(null);
  const [clearPending, setClearPending] = useState(false);
  const [pendingRemote, setPendingRemote] = useState<PendingRemoteUpdate | null>(null);
  const [presenceCount, setPresenceCount] = useState<number | null>(null);
  const [remoteNotice, setRemoteNotice] = useState<string | null>(null);
  const [exportState, setExportState] = useState<ExportState>({ status: "idle" });

  const controllerRef = useRef<RoomController | null>(null);
  const roomCodeRef = useRef<string | null>(null);
  const connectionPhaseRef = useRef<ConnectionPhase>("closed");
  const hasOpenedRef = useRef(false);
  const hasReceivedSnapshotRef = useRef(false);
  const snapshotReadyRef = useRef(false);
  const clearPendingRef = useRef(false);
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

  const dismissRemoteNotice = useCallback(() => {
    setRemoteNotice(null);
  }, []);

  const showRemoteNotice = useCallback((nextText: string) => {
    setRemoteNotice(remoteContentNotice(nextText));
  }, []);

  const resetRoomData = useCallback(() => {
    snapshotReadyRef.current = false;
    setSnapshotReady(false);
    clearPendingRef.current = false;
    hasOpenedRef.current = false;
    hasReceivedSnapshotRef.current = false;
    clearPendingWrites(false);
    setPendingRemote(null);
    setPresenceCount(null);
    setRemoteNotice(null);
    setExportState({ status: "idle" });
    setRoomNotice(null);
    setRoomKind(null);
    setExpiresAfterMinutes(null);
    setClearPending(false);
    setText("");
    draftTextRef.current = "";
    syncedTextRef.current = "";
    versionRef.current = 0;
    lastWriteDispatchAtRef.current = 0;
    setVersion(0);
    clientIdRef.current = null;
  }, [clearPendingWrites]);

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
    try {
      field.select();
      if (!document.execCommand("copy")) {
        throw new Error("clipboard copy command failed");
      }
    } finally {
      field.remove();
    }
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
        const opened = await openRoom(code, pin);
        activateRoom(code);
        setRoomKind(opened.kind);
        setExpiresAfterMinutes(opened.expiresAfterMinutes);
        setRoomNotice(opened.created ? "Clipboard criado. Abra este mesmo endereço na outra máquina." : "Clipboard aberto.");
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
      setRoomKind(created.kind);
      setExpiresAfterMinutes(created.expiresAfterMinutes);
      setRoomNotice("Código aleatório criado. Compartilhe o endereço com a outra máquina.");
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
    setRoomNotice(null);
  }, [clearRoomUrl, resetRoomData]);

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

  const handleCopyRoomText = useCallback(async () => {
    if (!text) {
      return;
    }

    try {
      await copyText(text);
      dismissRemoteNotice();
      setRoomNotice("Texto copiado.");
      setErrorMessage(null);
    } catch {
      setErrorMessage("Não foi possível copiar o texto agora.");
    }
  }, [copyText, dismissRemoteNotice, text]);

  const handleCopyRoomLink = useCallback(async () => {
    if (!roomCode) {
      return;
    }

    try {
      const roomUrl = new URL(textRoomPath(roomCode), window.location.origin).href;
      await copyText(roomUrl);
      setRoomNotice("Endereço do clipboard copiado.");
      setErrorMessage(null);
    } catch {
      setErrorMessage("Não foi possível copiar o endereço agora.");
    }
  }, [copyText, roomCode]);

  const handleClearRoomText = useCallback(() => {
    if (
      !text ||
      connectionPhaseRef.current !== "open" ||
      !snapshotReadyRef.current ||
      !window.confirm("Limpar o texto para todas as máquinas conectadas?")
    ) {
      return;
    }

    clearDebounceTimer();
    clearPendingRef.current = true;
    setClearPending(true);
    setPendingRemote(null);
    setText("");
    draftTextRef.current = "";
    queuedTextRef.current = "";
    dismissRemoteNotice();
    flushPendingWrite();
    setRoomNotice("Limpando clipboard...");
    setErrorMessage(null);
  }, [clearDebounceTimer, dismissRemoteNotice, flushPendingWrite, text]);

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
    clearPendingRef.current = false;
    setClearPending(false);
    setPendingRemote(null);
    setRoomNotice(null);
    showRemoteNotice(pendingRemote.text);
    setText(pendingRemote.text);
    draftTextRef.current = pendingRemote.text;
    syncedTextRef.current = pendingRemote.text;
    versionRef.current = pendingRemote.version;
    setVersion(pendingRemote.version);
  }, [clearPendingWrites, pendingRemote, showRemoteNotice]);

  const handleTextChange = useCallback(
    (event: ChangeEvent<HTMLTextAreaElement>) => {
      const nextText = event.currentTarget.value;
      if (clearPendingRef.current) {
        clearPendingRef.current = false;
        setClearPending(false);
        setRoomNotice(null);
      }
      dismissRemoteNotice();
      draftTextRef.current = nextText;
      setText(nextText);
      queuedTextRef.current = nextText;

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
    [clearDebounceTimer, dismissRemoteNotice, flushPendingWrite, scheduleFlush],
  );

  const handleTextPaste = useCallback(() => {
    flushAfterNextChangeRef.current = true;
  }, []);

  const handleTextBlur = useCallback(() => {
    clearDebounceTimer();
    flushPendingWrite();
  }, [clearDebounceTimer, flushPendingWrite]);

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
        const shouldRetryClear = clearPendingRef.current && payload.text !== "";
        const clearConfirmed = clearPendingRef.current && payload.text === "";
        const receivedChangedSnapshot =
          hasReceivedSnapshotRef.current &&
          payload.text !== syncedTextRef.current &&
          !shouldRetryClear &&
          !clearConfirmed;

        snapshotReadyRef.current = true;
        setSnapshotReady(true);
        hasReceivedSnapshotRef.current = true;
        clearPendingWrites(false);
        hasOpenedRef.current = true;
        draftTextRef.current = shouldRetryClear ? "" : payload.text;
        syncedTextRef.current = payload.text;
        queuedTextRef.current = shouldRetryClear ? "" : null;
        versionRef.current = payload.version;
        clientIdRef.current = payload.clientId;
        setText(shouldRetryClear ? "" : payload.text);
        setVersion(payload.version);
        setRoomKind(payload.kind);
        setExpiresAfterMinutes(payload.expiresAfterMinutes);
        setPendingRemote(null);
        setErrorMessage(null);

        if (clearConfirmed) {
          clearPendingRef.current = false;
          setClearPending(false);
          setRoomNotice("Clipboard limpo.");
        } else if (shouldRetryClear) {
          setRoomNotice("Limpando clipboard...");
        } else if (receivedChangedSnapshot) {
          showRemoteNotice(payload.text);
        }

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
          showRemoteNotice(payload.text);
          return;
        }

        setPendingRemote({ text: payload.text, version: payload.version });
      },
      onPresence(payload) {
        setPresenceCount(payload.count);
      },
      onTyping() {},
      onPointer() {},
      onPeerLeft() {},
      onAck(payload) {
        if (discardNextAckRef.current) {
          discardNextAckRef.current = false;
          return;
        }

        const acknowledgedText = sentTextRef.current;
        versionRef.current = payload.version;
        setVersion(payload.version);
        if (acknowledgedText !== null) {
          syncedTextRef.current = acknowledgedText;
          sentTextRef.current = null;
          inFlightRef.current = false;
        }

        if (clearPendingRef.current && acknowledgedText === "") {
          clearPendingRef.current = false;
          setClearPending(false);
          setPendingRemote(null);
          setRoomNotice("Clipboard limpo.");
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
        setSnapshotReady(false);

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
      controller.close();
      if (controllerRef.current === controller) {
        controllerRef.current = null;
      }
    };
  }, [
    clearPendingWrites,
    clearRoomUrl,
    flushPendingWrite,
    initialCode,
    requestRoomOpen,
    resetRoomData,
    roomCode,
    showRemoteNotice,
  ]);
  useEffect(() => {
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape" && roomCodeRef.current) {
        event.preventDefault();
        leaveRoom();
        return;
      }

      if (roomCodeRef.current && draftTextRef.current && isCopyTextShortcut(event)) {
        event.preventDefault();
        void handleCopyRoomText();
      }
    };

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [handleCopyRoomText, leaveRoom]);

  useEffect(() => {
    return () => {
      clearDebounceTimer();
      controllerRef.current?.close();
    };
  }, [clearDebounceTimer]);

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
  const presenceLabel =
    presenceCount === null ? null : `${presenceCount} ${presenceCount === 1 ? "conectado" : "conectados"}`;
  const exportButtonLabel = exportState.status === "uploading" ? "Enviando..." : "Enviar como arquivo";
  const showExportSuccess = exportState.status === "success";
  const showExportError = exportState.status === "error";
  const pinLabel = pinRequired ? "PIN da sala" : "PIN (opcional)";
  const primaryJoinLabel = isJoining ? "Abrindo..." : "Abrir";
  const createLabel = isJoining ? "Gerando..." : "Gerar código aleatório";
  const expiryLabel = expiresAfterMinutes === null
    ? null
    : `Expira ${expiresAfterMinutes >= 60 && expiresAfterMinutes % 60 === 0 ? `${expiresAfterMinutes / 60}h` : `${expiresAfterMinutes} min`} depois que todos saírem.`;

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

          {errorMessage ? <p className="quickdrop-text-note quickdrop-text-note--error" role="alert">{errorMessage}</p> : null}

          <label className="quickdrop-text-field">
            <span>Digite um código</span>
            <input
              className="quickdrop-text-input"
              autoComplete="off"
              autoFocus
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
            <button
              className="quickdrop-text-button"
              type="button"
              aria-expanded={showPrivacyOptions}
              disabled={isJoining}
              onClick={() => setShowPrivacyOptions((current) => !current)}
            >
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
              <p className="quickdrop-text-kicker">Clipboard ativo</p>
              <div className="quickdrop-text-room-code-row">
                <h1 className="quickdrop-text-room-code">{roomCode}</h1>
                <button
                  className="quickdrop-text-button quickdrop-text-button--primary"
                  type="button"
                  aria-keyshortcuts="Control+Enter Meta+Enter"
                  disabled={text.length === 0}
                  onClick={handleCopyRoomText}
                  title="Copiar texto (Ctrl/⌘ + Enter)"
                >
                  Copiar texto
                </button>
                <button className="quickdrop-text-button" type="button" onClick={handleCopyRoomLink}>
                  Compartilhar endereço
                </button>
                <button className="quickdrop-text-button quickdrop-text-button--ghost" type="button" onClick={handleCopyCode}>
                  Copiar código
                </button>
                <button
                  className="quickdrop-text-button quickdrop-text-button--ghost"
                  type="button"
                  disabled={clearPending || text.length === 0 || connectionPhase !== "open" || !snapshotReady}
                  onClick={handleClearRoomText}
                >
                  {clearPending ? "Limpando..." : "Limpar clipboard"}
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
              {expiryLabel ? <p className="quickdrop-text-room-presence">{expiryLabel}{roomKind === "custom" ? " Código público." : ""}</p> : null}
            </div>
          </div>

          <span
            className={`quickdrop-text-badge quickdrop-text-badge--${badgeVariant ?? "closed"}`}
            role="status"
            aria-live="polite"
            aria-label={`Status da conexão: ${statusLabel}`}
          >
            {statusLabel}
          </span>
        </header>

        {roomNotice ? <p className="quickdrop-text-note quickdrop-text-note--success" aria-live="polite" aria-atomic="true">{roomNotice}</p> : null}
        {remoteNotice ? (
          <p className="quickdrop-text-note quickdrop-text-note--remote" role="status" aria-live="polite" aria-atomic="true">
            {remoteNotice}
          </p>
        ) : null}
        {showExportError ? <p className="quickdrop-text-note quickdrop-text-note--error" role="alert">{exportState.message}</p> : null}
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
        {errorMessage ? <p className="quickdrop-text-note quickdrop-text-note--error" role="alert">{errorMessage}</p> : null}
        {pendingRemote ? (
          <div className="quickdrop-text-banner" role="status" aria-live="polite">
            <p>Conteúdo atualizado em outra máquina</p>
            <button className="quickdrop-text-button quickdrop-text-button--banner" type="button" onClick={handleRemoteOverride}>
              Carregar
            </button>
          </div>
        ) : null}

        <div className={`quickdrop-text-editor${remoteNotice ? " quickdrop-text-editor--remote" : ""}`}>
          <label className="sr-only" htmlFor="quickdrop-shared-text">Texto compartilhado</label>
          <textarea
            id="quickdrop-shared-text"
            className="quickdrop-text-textarea"
            value={text}
            aria-describedby="quickdrop-text-shortcuts"
            aria-keyshortcuts="Control+Enter Meta+Enter"
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
        <p id="quickdrop-text-shortcuts" className="quickdrop-text-shortcuts">
          Ctrl/⌘ + Enter para copiar · Esc para sair
        </p>
      </section>
    </main>
  );
}
