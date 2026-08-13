import { useCallback, useEffect, useRef, useState } from "react";
import {
  connectRoom,
  createRoom,
  openRoom,
  recordTextMetric,
  RoomAccessError,
  type ClientTextMetricErrorCategory,
  type RoomController,
  type RoomKind,
  type TextDrop,
} from "./text-client";
import { dropContentTypeLabel, isPublishDropShortcut } from "./text-session-shortcuts";
import { uploadFiles } from "./tauri";
import { initialRoomCode, setRoomInUrl, textRoomPath } from "./web-route";

type ConnectionPhase = "connecting" | "open" | "closed";
type ExportState =
  | { status: "idle" }
  | { status: "uploading" }
  | { status: "success"; url: string; copied: boolean }
  | { status: "error"; message: string };

function metricErrorCategory(error: unknown): ClientTextMetricErrorCategory {
  if (!(error instanceof RoomAccessError)) {
    return "network";
  }

  switch (error.code) {
    case "pin_required":
    case "pin_invalid":
    case "invalid_token":
    case "not_found":
    case "room_full":
    case "too_large":
    case "invalid_code":
    case "session_limit":
      return error.code;
    default:
      return "unknown";
  }
}

function sortDrops(drops: TextDrop[]): TextDrop[] {
  return [...drops].sort((left, right) => {
    const byDate = Date.parse(right.createdAt) - Date.parse(left.createdAt);
    return byDate === 0 ? right.id.localeCompare(left.id) : byDate;
  });
}

function formatDropTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return "Agora";
  }

  return new Intl.DateTimeFormat("pt-BR", {
    hour: "2-digit",
    minute: "2-digit",
    day: "2-digit",
    month: "short",
  }).format(date);
}

function legacyLiveDrop(text: string, version: number, dropExpiresAfterMinutes: number): TextDrop {
  const createdAt = new Date();
  return {
    id: `legacy-live-${version}`,
    content: text,
    contentType: "text",
    createdAt: createdAt.toISOString(),
    expiresAt: new Date(createdAt.getTime() + dropExpiresAfterMinutes * 60 * 1000).toISOString(),
  };
}

export default function TextSession() {
  const initialCode = initialRoomCode();
  const [roomCode, setRoomCode] = useState<string | null>(null);
  const [joinCode, setJoinCode] = useState(initialCode ?? "");
  const [joinPin, setJoinPin] = useState("");
  const [pinRequired, setPinRequired] = useState(false);
  const [showPrivacyOptions, setShowPrivacyOptions] = useState(false);
  const [isJoining, setIsJoining] = useState(false);
  const [composer, setComposer] = useState("");
  const [drops, setDrops] = useState<TextDrop[]>([]);
  const [connectionPhase, setConnectionPhase] = useState<ConnectionPhase>("closed");
  const [snapshotReady, setSnapshotReady] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [roomNotice, setRoomNotice] = useState<string | null>(null);
  const [roomKind, setRoomKind] = useState<RoomKind | null>(null);
  const [expiresAfterMinutes, setExpiresAfterMinutes] = useState<number | null>(null);
  const [dropExpiresAfterMinutes, setDropExpiresAfterMinutes] = useState<number | null>(null);
  const [maxDrops, setMaxDrops] = useState<number | null>(null);
  const [presenceCount, setPresenceCount] = useState<number | null>(null);
  const [remoteDropId, setRemoteDropId] = useState<string | null>(null);
  const [isPublishing, setIsPublishing] = useState(false);
  const [isClearing, setIsClearing] = useState(false);
  const [exportState, setExportState] = useState<ExportState>({ status: "idle" });

  const controllerRef = useRef<RoomController | null>(null);
  const dropsRef = useRef<TextDrop[]>([]);
  const roomCodeRef = useRef<string | null>(null);
  const roomKindRef = useRef<RoomKind | null>(null);
  const dropTtlMinutesRef = useRef(720);
  const connectionPhaseRef = useRef<ConnectionPhase>("closed");
  const snapshotReadyRef = useRef(false);
  const clientIdRef = useRef<string | null>(null);
  const leavingRoomRef = useRef(false);
  const suppressNextClosedRef = useRef(false);
  const preserveJoinContextRef = useRef(false);
  const autoJoinAttemptedRef = useRef(false);
  const hasOpenedRef = useRef(false);
  const remoteHighlightTimerRef = useRef<number | null>(null);
  const composerRef = useRef<HTMLTextAreaElement | null>(null);
  const clearComposerAfterPublishRef = useRef(true);

  const replaceDrops = useCallback((update: TextDrop[] | ((current: TextDrop[]) => TextDrop[])) => {
    const next = typeof update === "function" ? update(dropsRef.current) : update;
    dropsRef.current = next;
    setDrops(next);
  }, []);

  const clearRemoteHighlight = useCallback(() => {
    if (remoteHighlightTimerRef.current !== null) {
      window.clearTimeout(remoteHighlightTimerRef.current);
      remoteHighlightTimerRef.current = null;
    }
    setRemoteDropId(null);
  }, []);

  const highlightRemoteDrop = useCallback((dropId: string) => {
    if (remoteHighlightTimerRef.current !== null) {
      window.clearTimeout(remoteHighlightTimerRef.current);
    }
    setRemoteDropId(dropId);
    remoteHighlightTimerRef.current = window.setTimeout(() => {
      remoteHighlightTimerRef.current = null;
      setRemoteDropId(null);
    }, 8000);
  }, []);

  const resetRoomData = useCallback(() => {
    snapshotReadyRef.current = false;
    clientIdRef.current = null;
    roomKindRef.current = null;
    dropTtlMinutesRef.current = 720;
    hasOpenedRef.current = false;
    clearRemoteHighlight();
    setSnapshotReady(false);
    setComposer("");
    replaceDrops([]);
    setPresenceCount(null);
    setRoomNotice(null);
    setRoomKind(null);
    setExpiresAfterMinutes(null);
    setDropExpiresAfterMinutes(null);
    setMaxDrops(null);
    setIsPublishing(false);
    setIsClearing(false);
    setExportState({ status: "idle" });
  }, [clearRemoteHighlight, replaceDrops]);

  const clearRoomUrl = useCallback(() => {
    history.replaceState(history.state, "", "/t");
  }, []);

  const activateRoom = useCallback(
    (code: string) => {
      const normalized = code.trim().toUpperCase();
      if (!normalized) {
        return;
      }

      resetRoomData();
      roomCodeRef.current = normalized;
      setRoomCode(normalized);
      setJoinCode(normalized);
      setJoinPin("");
      setPinRequired(false);
      setErrorMessage(null);
      connectionPhaseRef.current = "connecting";
      setConnectionPhase("connecting");
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
    void recordTextMetric({ event: "client_error", errorCategory: metricErrorCategory(error) });
    if (error instanceof RoomAccessError) {
      if (error.code === "pin_required" || error.code === "pin_invalid" || error.code === "invalid_token") {
        setPinRequired(true);
      }
      setErrorMessage(error.message);
      return;
    }
    setErrorMessage(error instanceof Error ? error.message : "Falha ao acessar o clipboard");
  }, []);

  const requestRoomOpen = useCallback(
    async (code: string, pin?: string) => {
      setIsJoining(true);
      try {
        const opened = await openRoom(code, pin);
        activateRoom(opened.code);
        roomKindRef.current = opened.kind;
        setRoomKind(opened.kind);
        setExpiresAfterMinutes(opened.expiresAfterMinutes);
        setRoomNotice(opened.created ? "Clipboard criado. Abra este endereço na outra máquina." : "Clipboard aberto.");
      } catch (error) {
        handleAccessError(error);
      } finally {
        setIsJoining(false);
      }
    },
    [activateRoom, handleAccessError],
  );

  const handleJoin = useCallback(() => {
    if (joinCode.trim()) {
      void requestRoomOpen(joinCode, joinPin);
    }
  }, [joinCode, joinPin, requestRoomOpen]);

  const handleCreateRoom = useCallback(async () => {
    setIsJoining(true);
    try {
      const created = await createRoom(joinPin);
      activateRoom(created.code);
      roomKindRef.current = created.kind;
      setRoomKind(created.kind);
      setExpiresAfterMinutes(created.expiresAfterMinutes);
      setRoomNotice("Código aleatório criado. Compartilhe o endereço com a outra máquina.");
    } catch (error) {
      handleAccessError(error);
    } finally {
      setIsJoining(false);
    }
  }, [activateRoom, handleAccessError, joinPin]);

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
    connectionPhaseRef.current = "closed";
    setConnectionPhase("closed");
    setErrorMessage(null);
  }, [clearRoomUrl, resetRoomData]);

  const publishDrop = useCallback((content = composer, clearComposerAfterPublish = true) => {
    if (
      !content.trim() ||
      connectionPhaseRef.current !== "open" ||
      !snapshotReadyRef.current ||
      !controllerRef.current
    ) {
      return;
    }

    setIsPublishing(true);
    clearComposerAfterPublishRef.current = clearComposerAfterPublish;
    setErrorMessage(null);
    setRoomNotice(clearComposerAfterPublish ? "Enviando item..." : "Reenviando item...");
    controllerRef.current.addDrop(content);
  }, [composer]);

  const handleCopyDrop = useCallback(async (drop: TextDrop) => {
    try {
      await copyText(drop.content);
      clearRemoteHighlight();
      void recordTextMetric({
        event: "text_copied",
        ...(roomKindRef.current ? { roomKind: roomKindRef.current } : {}),
      });
      setRoomNotice("Item copiado.");
      setErrorMessage(null);
    } catch {
      void recordTextMetric({
        event: "client_error",
        ...(roomKindRef.current ? { roomKind: roomKindRef.current } : {}),
        errorCategory: "clipboard",
      });
      setErrorMessage("Não foi possível copiar este item agora.");
    }
  }, [clearRemoteHighlight, copyText]);

  const handleCopyLatest = useCallback(() => {
    const latest = drops[0];
    if (latest) {
      void handleCopyDrop(latest);
    }
  }, [drops, handleCopyDrop]);

  const handleCopyCode = useCallback(async () => {
    if (!roomCode) {
      return;
    }
    try {
      await copyText(roomCode);
      setRoomNotice("Código copiado.");
      setErrorMessage(null);
    } catch {
      setErrorMessage("Não foi possível copiar o código agora.");
    }
  }, [copyText, roomCode]);

  const handleCopyRoomLink = useCallback(async () => {
    if (!roomCode) {
      return;
    }
    try {
      await copyText(new URL(textRoomPath(roomCode), window.location.origin).href);
      setRoomNotice("Endereço do clipboard copiado.");
      setErrorMessage(null);
    } catch {
      setErrorMessage("Não foi possível copiar o endereço agora.");
    }
  }, [copyText, roomCode]);

  const handleDeleteDrop = useCallback((drop: TextDrop) => {
    if (connectionPhaseRef.current !== "open" || !snapshotReadyRef.current) {
      return;
    }
    controllerRef.current?.deleteDrop(drop.id);
    setRoomNotice("Excluindo item...");
  }, []);

  const handleClearDrops = useCallback(() => {
    if (
      drops.length === 0 ||
      connectionPhaseRef.current !== "open" ||
      !snapshotReadyRef.current ||
      !window.confirm("Limpar todos os itens para todas as máquinas conectadas?")
    ) {
      return;
    }
    setIsClearing(true);
    setRoomNotice("Limpando clipboard...");
    controllerRef.current?.clearDrops();
  }, [drops.length]);

  const handleExportDrops = useCallback(async () => {
    if (!roomCode || drops.length === 0) {
      return;
    }
    setExportState({ status: "uploading" });
    const content = [...drops]
      .reverse()
      .map((drop) => `[${drop.createdAt}] ${dropContentTypeLabel(drop.contentType)}\n${drop.content}`)
      .join("\n\n---\n\n");

    try {
      const uploaded = await uploadFiles([
        new File([content], `quickdrop-${roomCode}-timeline.txt`, { type: "text/plain" }),
      ]);
      try {
        await copyText(uploaded.url);
        setExportState({ status: "success", url: uploaded.url, copied: true });
      } catch {
        setExportState({ status: "success", url: uploaded.url, copied: false });
      }
    } catch (error) {
      setExportState({
        status: "error",
        message: error instanceof Error ? error.message : "Falha ao enviar a timeline como arquivo.",
      });
    }
  }, [copyText, drops, roomCode]);

  useEffect(() => {
    roomCodeRef.current = roomCode;
    if (roomCode) {
      setRoomInUrl(roomCode);
    }
  }, [roomCode]);

  useEffect(() => {
    document.documentElement.classList.add("quickdrop-text-page");
    void recordTextMetric({ event: "screen_opened" });
    return () => document.documentElement.classList.remove("quickdrop-text-page");
  }, []);

  useEffect(() => {
    if (!initialCode || roomCode || autoJoinAttemptedRef.current) {
      return;
    }
    autoJoinAttemptedRef.current = true;
    void requestRoomOpen(initialCode);
  }, [initialCode, requestRoomOpen, roomCode]);

  useEffect(() => {
    if (!roomCode) {
      return;
    }

    const controller = connectRoom(roomCode, {
      onSnapshot(payload) {
        snapshotReadyRef.current = true;
        setSnapshotReady(true);
        hasOpenedRef.current = true;
        clientIdRef.current = payload.clientId;
        roomKindRef.current = payload.kind;
        setRoomKind(payload.kind);
        setExpiresAfterMinutes(payload.expiresAfterMinutes);
        setDropExpiresAfterMinutes(payload.dropExpiresAfterMinutes);
        dropTtlMinutesRef.current = payload.dropExpiresAfterMinutes;
        setMaxDrops(payload.maxDrops);
        const snapshotDrops = payload.text && payload.drops[0]?.content !== payload.text
          ? [legacyLiveDrop(payload.text, payload.version, payload.dropExpiresAfterMinutes), ...payload.drops]
          : payload.drops;
        replaceDrops(sortDrops(snapshotDrops));
        setIsPublishing(false);
        setIsClearing(false);
        setErrorMessage(null);
      },
      onDropAdded(payload) {
        replaceDrops((current) => sortDrops([
          payload.drop,
          ...current.filter((drop) => drop.id !== payload.drop.id && !drop.id.startsWith("legacy-live-")),
        ]));
        setIsPublishing(false);
        if (payload.by === clientIdRef.current) {
          if (clearComposerAfterPublishRef.current) {
            setComposer("");
          }
          clearComposerAfterPublishRef.current = true;
          setRoomNotice("Item enviado.");
          window.setTimeout(() => composerRef.current?.focus(), 0);
        } else {
          highlightRemoteDrop(payload.drop.id);
          setRoomNotice("Novo item recebido de outro dispositivo.");
        }
      },
      onDropsRemoved(payload) {
        const removed = new Set(payload.dropIds);
        replaceDrops((current) => current.filter((drop) => !removed.has(drop.id)));
      },
      onDropDeleted(payload) {
        replaceDrops((current) => current.filter((drop) => drop.id !== payload.dropId));
        setRoomNotice("Item excluído.");
      },
      onDropsCleared() {
        clearRemoteHighlight();
        replaceDrops([]);
        setIsClearing(false);
        setRoomNotice("Clipboard limpo.");
      },
      onPresence(payload) {
        setPresenceCount(payload.count);
      },
      // Represent a legacy client's live document as one replaceable virtual item.
      onUpdate(payload) {
        if (payload.origin === "drop_sync") {
          return;
        }

        const virtualPrefix = "legacy-live-";
        const current = dropsRef.current;
        const hadLegacy = current.some((drop) => drop.id.startsWith(virtualPrefix));
        const withoutLegacy = current.filter((drop) => !drop.id.startsWith(virtualPrefix));
        if (!payload.text) {
          replaceDrops(withoutLegacy);
          if (hadLegacy) {
            setRoomNotice("Texto legado limpo.");
          }
          return;
        }
        if (withoutLegacy[0]?.content === payload.text) {
          replaceDrops(withoutLegacy);
          return;
        }

        const virtual = legacyLiveDrop(payload.text, payload.version, dropTtlMinutesRef.current);
        const nextDrops = sortDrops([virtual, ...withoutLegacy]);
        replaceDrops(nextDrops);
        highlightRemoteDrop(virtual.id);
        setRoomNotice("Texto recebido de um cliente anterior.");
      },
      onTyping() {},
      onPointer() {},
      onPeerLeft() {},
      onAck() {},
      onError(payload) {
        setIsPublishing(false);
        setIsClearing(false);
        void recordTextMetric({
          event: "client_error",
          ...(roomKindRef.current ? { roomKind: roomKindRef.current } : {}),
          errorCategory: metricErrorCategory(new RoomAccessError(payload.message, payload.code)),
        });
        if (payload.code === "pin_required" || payload.code === "pin_invalid" || payload.code === "invalid_token") {
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

        snapshotReadyRef.current = false;
        setSnapshotReady(false);
        setIsPublishing(false);
        setIsClearing(false);
        if (status !== "closed") {
          return;
        }
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
        roomCodeRef.current = null;
        setRoomCode(null);
        clearRoomUrl();
        resetRoomData();
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
  }, [clearRemoteHighlight, clearRoomUrl, highlightRemoteDrop, replaceDrops, resetRoomData, roomCode]);

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

  useEffect(() => () => {
    if (remoteHighlightTimerRef.current !== null) {
      window.clearTimeout(remoteHighlightTimerRef.current);
    }
    controllerRef.current?.close();
  }, []);

  const badgeVariant = roomCode
    ? connectionPhase === "open"
      ? "open"
      : connectionPhase === "closed"
        ? "closed"
        : hasOpenedRef.current
          ? "reconnecting"
          : "connecting"
    : null;
  const statusLabel = badgeVariant === "open"
    ? "Conectado"
    : badgeVariant === "closed"
      ? "Desconectado"
      : badgeVariant === "reconnecting"
        ? "Reconectando"
        : "Conectando";
  const presenceLabel = presenceCount === null
    ? null
    : `${presenceCount} ${presenceCount === 1 ? "conectado" : "conectados"}`;
  const expiryLabel = expiresAfterMinutes === null
    ? null
    : `Sala expira ${expiresAfterMinutes >= 60 && expiresAfterMinutes % 60 === 0 ? `${expiresAfterMinutes / 60}h` : `${expiresAfterMinutes} min`} depois que todos saírem.`;
  const dropPolicyLabel = dropExpiresAfterMinutes === null
    ? null
    : `Itens duram ${dropExpiresAfterMinutes >= 60 && dropExpiresAfterMinutes % 60 === 0 ? `${dropExpiresAfterMinutes / 60}h` : `${dropExpiresAfterMinutes} min`}${maxDrops ? ` · máximo ${maxDrops}` : ""}.`;
  if (!roomCode) {
    const primaryJoinLabel = isJoining ? "Abrindo..." : "Abrir";
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
                <span>{pinRequired ? "PIN da sala" : "PIN (opcional)"}</span>
                <input
                  className="quickdrop-text-input"
                  autoComplete="off"
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
                {isJoining ? "Gerando..." : "Gerar código aleatório"}
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
            <button className="quickdrop-text-icon-button" type="button" onClick={leaveRoom}>← Voltar</button>
            <div>
              <p className="quickdrop-text-kicker">Clipboard ativo</p>
              <div className="quickdrop-text-room-code-row">
                <h1 className="quickdrop-text-room-code">{roomCode}</h1>
                <button className="quickdrop-text-button quickdrop-text-button--primary" type="button" disabled={drops.length === 0} onClick={handleCopyLatest}>
                  Copiar mais recente
                </button>
                <button className="quickdrop-text-button" type="button" onClick={handleCopyRoomLink}>Compartilhar endereço</button>
                <button className="quickdrop-text-button quickdrop-text-button--ghost" type="button" onClick={handleCopyCode}>Copiar código</button>
                <button
                  className="quickdrop-text-button quickdrop-text-button--ghost"
                  type="button"
                  disabled={isClearing || drops.length === 0 || connectionPhase !== "open" || !snapshotReady}
                  onClick={handleClearDrops}
                >
                  {isClearing ? "Limpando..." : "Limpar todos"}
                </button>
                <button className="quickdrop-text-button" type="button" disabled={exportState.status === "uploading" || drops.length === 0} onClick={handleExportDrops}>
                  {exportState.status === "uploading" ? "Enviando..." : "Enviar timeline como arquivo"}
                </button>
              </div>
              {presenceLabel ? <p className="quickdrop-text-room-presence">{presenceLabel}</p> : null}
              {expiryLabel ? <p className="quickdrop-text-room-presence">{expiryLabel}{roomKind === "custom" ? " Código público." : ""}</p> : null}
              {dropPolicyLabel ? <p className="quickdrop-text-room-presence">{dropPolicyLabel}</p> : null}
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
        {errorMessage ? <p className="quickdrop-text-note quickdrop-text-note--error" role="alert">{errorMessage}</p> : null}
        {exportState.status === "error" ? <p className="quickdrop-text-note quickdrop-text-note--error" role="alert">{exportState.message}</p> : null}
        {exportState.status === "success" ? (
          <p className="quickdrop-text-note quickdrop-text-note--success">
            {exportState.copied ? "Timeline enviada. Link copiado." : <>Timeline enviada. <a href={exportState.url} target="_blank" rel="noreferrer">Abrir link</a></>}
          </p>
        ) : null}

        <section className="quickdrop-drop-composer" aria-labelledby="quickdrop-drop-composer-title">
          <div>
            <p className="quickdrop-text-kicker">Novo item</p>
            <h2 id="quickdrop-drop-composer-title">Cole uma vez, mantenha o histórico</h2>
          </div>
          <label className="sr-only" htmlFor="quickdrop-drop-content">Texto do novo item</label>
          <textarea
            ref={composerRef}
            id="quickdrop-drop-content"
            className="quickdrop-drop-composer-input"
            value={composer}
            onChange={(event) => {
              clearRemoteHighlight();
              setComposer(event.currentTarget.value);
            }}
            onKeyDown={(event) => {
              if (isPublishDropShortcut(event.nativeEvent)) {
                event.preventDefault();
                publishDrop();
              }
            }}
            spellCheck={false}
            autoCapitalize="off"
            autoCorrect="off"
            autoComplete="off"
            autoFocus
            placeholder="Digite ou cole um texto, URL, comando ou JSON..."
            aria-describedby="quickdrop-drop-shortcuts"
            aria-keyshortcuts="Control+Enter Meta+Enter"
          />
          <div className="quickdrop-drop-composer-footer">
            <p id="quickdrop-drop-shortcuts">Ctrl/⌘ + Enter para enviar · Esc para sair</p>
            <button
              className="quickdrop-text-button quickdrop-text-button--primary"
              type="button"
              disabled={!composer.trim() || isPublishing || connectionPhase !== "open" || !snapshotReady}
              onClick={() => publishDrop()}
            >
              {isPublishing ? "Enviando..." : "Enviar item"}
            </button>
          </div>
        </section>

        <section className="quickdrop-drop-timeline" aria-labelledby="quickdrop-drop-timeline-title">
          <div className="quickdrop-drop-timeline-heading">
            <div>
              <p className="quickdrop-text-kicker">Histórico</p>
              <h2 id="quickdrop-drop-timeline-title">{drops.length} {drops.length === 1 ? "item" : "itens"}</h2>
            </div>
          </div>

          {drops.length === 0 ? (
            <div className="quickdrop-drop-empty">
              <p>Nenhum item ainda.</p>
              <span>Envie o primeiro texto acima e abra este código na outra máquina.</span>
            </div>
          ) : (
            <ol className="quickdrop-drop-list">
              {drops.map((drop) => (
                <li
                  key={drop.id}
                  className={`quickdrop-drop-card${remoteDropId === drop.id ? " quickdrop-drop-card--remote" : ""}`}
                >
                  <div className="quickdrop-drop-card-header">
                    <span className={`quickdrop-drop-type quickdrop-drop-type--${drop.contentType}`}>{dropContentTypeLabel(drop.contentType)}</span>
                    <time dateTime={drop.createdAt}>{formatDropTime(drop.createdAt)}</time>
                  </div>
                  {drop.contentType === "url" ? (
                    <a className="quickdrop-drop-content quickdrop-drop-content--url" href={drop.content} target="_blank" rel="noopener noreferrer nofollow">
                      {drop.content}
                    </a>
                  ) : (
                    <pre className="quickdrop-drop-content"><code>{drop.content}</code></pre>
                  )}
                  <div className="quickdrop-drop-actions">
                    <button className="quickdrop-text-button quickdrop-text-button--primary" type="button" onClick={() => void handleCopyDrop(drop)}>Copiar</button>
                    <button className="quickdrop-text-button" type="button" disabled={connectionPhase !== "open" || !snapshotReady || isPublishing} onClick={() => publishDrop(drop.content, false)}>Reenviar</button>
                    <button className="quickdrop-text-button quickdrop-text-button--ghost" type="button" disabled={connectionPhase !== "open" || !snapshotReady || drop.id.startsWith("legacy-")} onClick={() => handleDeleteDrop(drop)}>Excluir</button>
                  </div>
                </li>
              ))}
            </ol>
          )}
        </section>
      </section>
    </main>
  );
}
