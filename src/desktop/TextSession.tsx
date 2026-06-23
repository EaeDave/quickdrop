import { type ChangeEvent, useCallback, useEffect, useRef, useState } from "react";
import { connectRoom, createRoom, type RoomController } from "./text-client";
import { uploadFiles } from "./tauri";
import { initialRoomCode, setRoomInUrl } from "./web-route";

type PendingRemoteUpdate = { text: string; version: number };
type ConnectionPhase = "connecting" | "open" | "closed";
type ExportState =
  | { status: "idle" }
  | { status: "uploading" }
  | { status: "success"; url: string; copied: boolean }
  | { status: "error"; message: string };

export default function TextSession() {
  const initialCode = initialRoomCode();
  const [roomCode, setRoomCode] = useState<string | null>(initialCode);
  const [joinCode, setJoinCode] = useState(initialCode ?? "");
  const [text, setText] = useState("");
  const [version, setVersion] = useState(0);
  const [clientId, setClientId] = useState<string | null>(null);
  const [connectionPhase, setConnectionPhase] = useState<ConnectionPhase>(initialCode ? "connecting" : "closed");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [pendingRemote, setPendingRemote] = useState<PendingRemoteUpdate | null>(null);
  const [presenceCount, setPresenceCount] = useState<number | null>(null);
  const [exportState, setExportState] = useState<ExportState>({ status: "idle" });

  const controllerRef = useRef<RoomController | null>(null);
  const roomCodeRef = useRef<string | null>(initialCode);
  const connectionPhaseRef = useRef<ConnectionPhase>(initialCode ? "connecting" : "closed");
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
  const discardNextAckRef = useRef(false);

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

  const resetRoomData = useCallback(() => {
    snapshotReadyRef.current = false;
    hasOpenedRef.current = false;
    clearPendingWrites(false);
    setPendingRemote(null);
    setPresenceCount(null);
    setExportState({ status: "idle" });
    setText("");
    draftTextRef.current = "";
    syncedTextRef.current = "";
    versionRef.current = 0;
    setVersion(0);
    clientIdRef.current = null;
    setClientId(null);
  }, [clearPendingWrites]);

  const clearRoomUrl = useCallback(() => {
    history.replaceState(history.state, "", "/t");
  }, []);

  const enterRoom = useCallback(
    (code: string) => {
      const normalized = code.trim().toUpperCase();
      if (normalized.length === 0) {
        return;
      }

      roomCodeRef.current = normalized;
      setRoomCode(normalized);
      setJoinCode(normalized);
      setErrorMessage(null);
      setPendingRemote(null);
      setConnectionPhase("connecting");
      resetRoomData();
      setRoomInUrl(normalized);
    },
    [resetRoomData],
  );

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
    controllerRef.current.sendWrite(nextText, versionRef.current);
  }, []);

  const scheduleFlush = useCallback(() => {
    clearDebounceTimer();
    debounceTimerRef.current = window.setTimeout(() => {
      debounceTimerRef.current = null;
      flushPendingWrite();
    }, 150);
  }, [clearDebounceTimer, flushPendingWrite]);

  const leaveRoom = useCallback(() => {
    leavingRoomRef.current = true;
    controllerRef.current?.close();
    controllerRef.current = null;
    roomCodeRef.current = null;
    setRoomCode(null);
    clearRoomUrl();
    resetRoomData();
    setConnectionPhase("closed");
    setPendingRemote(null);
    setErrorMessage(null);
  }, [clearRoomUrl, resetRoomData]);

  const handleJoin = useCallback(() => {
    enterRoom(joinCode);
  }, [enterRoom, joinCode]);

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

  const handleCreateRoom = useCallback(async () => {
    try {
      const code = await createRoom();
      enterRoom(code);
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : "Falha ao criar sala");
    }
  }, [enterRoom]);

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
      scheduleFlush();
    },
    [scheduleFlush],
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

        const hasLocalChanges = draftTextRef.current !== syncedTextRef.current || inFlightRef.current || queuedTextRef.current !== null;
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
      onPresence(payload) {
        setPresenceCount(payload.count);
      },
      onError(payload) {
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
  }, [clearPendingWrites, clearRoomUrl, flushPendingWrite, resetRoomData, roomCode]);

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
  const statusLabel = badgeVariant === "open" ? "Conectado" : badgeVariant === "closed" ? "Desconectado" : badgeVariant === "reconnecting" ? "Reconectando" : "Conectando";
  const presenceLabel =
    presenceCount === null ? null : `${presenceCount} ${presenceCount === 1 ? "conectado" : "conectados"}`;
  const exportButtonLabel = exportState.status === "uploading" ? "Enviando..." : "Enviar como arquivo";
  const showExportSuccess = exportState.status === "success";
  const showExportError = exportState.status === "error";


  if (!roomCode) {
    return (
      <main className="quickdrop-text-shell">
        <section className="quickdrop-text-card quickdrop-text-join">
          <div className="quickdrop-text-heading">
            <p className="quickdrop-text-kicker">Texto compartilhado</p>
            <h1>Sala de texto</h1>
            <p className="quickdrop-text-copy">Crie uma sala para colar SQL, comandos ou qualquer texto e abrir no outro computador.</p>
          </div>

          {errorMessage ? <p className="quickdrop-text-note quickdrop-text-note--error">{errorMessage}</p> : null}

          <label className="quickdrop-text-field">
            <span>Código da sala</span>
            <input
              className="quickdrop-text-input"
              autoComplete="off"
              inputMode="text"
              maxLength={6}
              placeholder="Ex.: K7QF2M"
              value={joinCode}
              onChange={(event) => setJoinCode(event.currentTarget.value.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 6))}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  handleJoin();
                }
              }}
            />
          </label>

          <div className="quickdrop-text-actions">
            <button className="quickdrop-text-button quickdrop-text-button--primary" type="button" disabled={!joinCode.trim()} onClick={handleJoin}>
              Entrar
            </button>
            <button className="quickdrop-text-button" type="button" onClick={handleCreateRoom}>
              Criar nova sala
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
                Texto enviado.{" "}
                <a href={exportState.url} target="_blank" rel="noreferrer">
                  Abrir link
                </a>
              </>
            )}
          </p>
        ) : null}
        {pendingRemote ? (
          <div className="quickdrop-text-banner">
            <p>Conteúdo atualizado em outra máquina</p>
            <button className="quickdrop-text-button quickdrop-text-button--banner" type="button" onClick={handleRemoteOverride}>
              Carregar
            </button>
          </div>
        ) : null}

        <label className="quickdrop-text-editor">
          <span className="sr-only">Conteúdo da sala</span>
          <textarea
            className="quickdrop-text-textarea"
            value={text}
            onChange={handleTextChange}
            spellCheck={false}
            autoCapitalize="off"
            autoCorrect="off"
            autoComplete="off"
            autoFocus
            placeholder="Digite ou cole algo aqui..."
          />
        </label>
      </section>
    </main>
  );
}
