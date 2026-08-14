import { useCallback, useEffect, useRef, useState } from "react";
import {
  connectRoom,
  createRoom,
  formatRoomExpiry,
  formatRoomPresence,
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
type DropOrigin = "unknown" | "self" | "remote";
type ExportState =
  | { status: "idle" }
  | { status: "uploading" }
  | { status: "success"; url: string; copied: boolean }
  | { status: "error"; message: string };

const NEW_DROP_DURATION_MS = 8000;

function dropOriginLabel(origin: DropOrigin): string {
  switch (origin) {
    case "self":
      return "Sent by you";
    case "remote":
      return "Sent from another device";
    default:
      return "Unknown origin";
  }
}

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
    return "Now";
  }

  return new Intl.DateTimeFormat("en-US", {
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
  const [roomExpiresAt, setRoomExpiresAt] = useState<string | null>(null);
  const [dropExpiresAfterMinutes, setDropExpiresAfterMinutes] = useState<number | null>(null);
  const [maxDrops, setMaxDrops] = useState<number | null>(null);
  const [presenceCount, setPresenceCount] = useState<number | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [dropOrigins, setDropOrigins] = useState<Record<string, DropOrigin>>({});
  const [latestRemoteDropId, setLatestRemoteDropId] = useState<string | null>(null);
  const [newDropId, setNewDropId] = useState<string | null>(null);
  const [isPublishing, setIsPublishing] = useState(false);
  const [isClearing, setIsClearing] = useState(false);
  const [exportState, setExportState] = useState<ExportState>({ status: "idle" });

  const controllerRef = useRef<RoomController | null>(null);
  const dropsRef = useRef<TextDrop[]>([]);
  const dropOriginsRef = useRef<Record<string, DropOrigin>>({});
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
  const newDropTimerRef = useRef<number | null>(null);
  const latestRemoteDropIdRef = useRef<string | null>(null);
  const composerRef = useRef<HTMLTextAreaElement | null>(null);
  const clearComposerAfterPublishRef = useRef(true);

  const replaceDrops = useCallback((update: TextDrop[] | ((current: TextDrop[]) => TextDrop[])) => {
    const next = typeof update === "function" ? update(dropsRef.current) : update;
    dropsRef.current = next;
    setDrops(next);
  }, []);

  const classifyDrops = useCallback((nextDrops: TextDrop[], origins: Record<string, DropOrigin>) => {
    dropOriginsRef.current = origins;
    setDropOrigins(origins);
    replaceDrops(nextDrops);
    const latest = nextDrops.find((drop) => origins[drop.id] === "remote")?.id ?? null;
    latestRemoteDropIdRef.current = latest;
    setLatestRemoteDropId(latest);
  }, [replaceDrops]);

  const markNewDrop = useCallback((dropId: string) => {
    if (newDropTimerRef.current !== null) {
      window.clearTimeout(newDropTimerRef.current);
    }
    setNewDropId(dropId);
    newDropTimerRef.current = window.setTimeout(() => {
      newDropTimerRef.current = null;
      setNewDropId(null);
    }, NEW_DROP_DURATION_MS);
  }, []);

  const clearDropHighlights = useCallback(() => {
    if (newDropTimerRef.current !== null) {
      window.clearTimeout(newDropTimerRef.current);
      newDropTimerRef.current = null;
    }
    latestRemoteDropIdRef.current = null;
    setLatestRemoteDropId(null);
    setNewDropId(null);
  }, []);
  const resetRoomData = useCallback(() => {
    snapshotReadyRef.current = false;
    clientIdRef.current = null;
    roomKindRef.current = null;
    dropTtlMinutesRef.current = 720;
    hasOpenedRef.current = false;
    dropOriginsRef.current = {};
    setDropOrigins({});
    clearDropHighlights();
    setSnapshotReady(false);
    setComposer("");
    replaceDrops([]);
    setPresenceCount(null);
    setRoomNotice(null);
    setRoomKind(null);
    setExpiresAfterMinutes(null);
    setRoomExpiresAt(null);
    setDropExpiresAfterMinutes(null);
    setMaxDrops(null);
    setIsPublishing(false);
    setIsClearing(false);
    setExportState({ status: "idle" });
  }, [clearDropHighlights, replaceDrops]);

  const clearRoomUrl = useCallback(() => {
    history.replaceState(history.state, "", "/");
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
    setErrorMessage(error instanceof Error ? error.message : "Failed to access the clipboard");
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
        setRoomExpiresAt(opened.expiresAt);
        setPresenceCount(opened.presence);
        const protection = opened.protected ? " with PIN protection" : " as a public room";
        setRoomNotice(opened.created
          ? `Clipboard created${protection}. Share this address with the other device.`
          : `Clipboard opened${protection}.`);
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
      setRoomExpiresAt(created.expiresAt);
      setPresenceCount(created.presence);
      setRoomNotice(created.protected
        ? "Random PIN-protected code created. Share the address with the other device."
        : "Random public code created. Share the address with the other device.");
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
    setRoomNotice(clearComposerAfterPublish ? "Sending item…" : "Sending item again…");
    controllerRef.current.addDrop(content);
  }, [composer]);

  const handleCopyDrop = useCallback(async (drop: TextDrop) => {
    try {
      await copyText(drop.content);
      void recordTextMetric({
        event: "text_copied",
        ...(roomKindRef.current ? { roomKind: roomKindRef.current } : {}),
      });
      setRoomNotice("Item copied.");
      setErrorMessage(null);
    } catch {
      void recordTextMetric({
        event: "client_error",
        ...(roomKindRef.current ? { roomKind: roomKindRef.current } : {}),
        errorCategory: "clipboard",
      });
      setErrorMessage("Could not copy this item.");
    }
  }, [copyText]);

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
      setRoomNotice("Code copied.");
      setErrorMessage(null);
    } catch {
      setErrorMessage("Could not copy the code.");
    }
  }, [copyText, roomCode]);

  const handleCopyRoomLink = useCallback(async () => {
    if (!roomCode) {
      return;
    }
    try {
      await copyText(new URL(textRoomPath(roomCode), window.location.origin).href);
      setRoomNotice("Clipboard address copied.");
      setErrorMessage(null);
    } catch {
      setErrorMessage("Could not copy the address.");
    }
  }, [copyText, roomCode]);

  const handleDeleteDrop = useCallback((drop: TextDrop) => {
    if (connectionPhaseRef.current !== "open" || !snapshotReadyRef.current) {
      return;
    }
    controllerRef.current?.deleteDrop(drop.id);
    setRoomNotice("Deleting item…");
  }, []);

  const handleClearDrops = useCallback(() => {
    if (
      drops.length === 0 ||
      connectionPhaseRef.current !== "open" ||
      !snapshotReadyRef.current ||
      !window.confirm("Clear all items for every connected device?")
    ) {
      return;
    }
    setIsClearing(true);
    setRoomNotice("Clearing clipboard…");
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
        message: error instanceof Error ? error.message : "Failed to upload the timeline as a file.",
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
    if (!roomNotice) {
      return;
    }
    const timer = window.setTimeout(() => setRoomNotice(null), 4000);
    return () => window.clearTimeout(timer);
  }, [roomNotice]);


  useEffect(() => {
    if (!roomCode || !roomExpiresAt || (presenceCount ?? 0) > 0) {
      return;
    }
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [presenceCount, roomCode, roomExpiresAt]);

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
        setRoomExpiresAt(payload.expiresAt);
        setPresenceCount(payload.presence);
        setDropExpiresAfterMinutes(payload.dropExpiresAfterMinutes);
        dropTtlMinutesRef.current = payload.dropExpiresAfterMinutes;
        setMaxDrops(payload.maxDrops);
        const snapshotDrops = payload.text && payload.drops[0]?.content !== payload.text
          ? [legacyLiveDrop(payload.text, payload.version, payload.dropExpiresAfterMinutes), ...payload.drops]
          : payload.drops;
        const knownOrigins = dropOriginsRef.current;
        const origins = Object.fromEntries(snapshotDrops.map((drop) => [drop.id, knownOrigins[drop.id] ?? "unknown"]));
        classifyDrops(sortDrops(snapshotDrops), origins);
        setIsPublishing(false);
        setIsClearing(false);
        setErrorMessage(null);
      },
      onDropAdded(payload) {
        const origin: DropOrigin = payload.by === clientIdRef.current ? "self" : "remote";
        const origins = { ...dropOriginsRef.current, [payload.drop.id]: origin };
        classifyDrops(sortDrops([
          payload.drop,
          ...dropsRef.current.filter((drop) => drop.id !== payload.drop.id && !drop.id.startsWith("legacy-live-")),
        ]), origins);
        setIsPublishing(false);
        if (origin === "self") {
          if (clearComposerAfterPublishRef.current) {
            setComposer("");
          }
          clearComposerAfterPublishRef.current = true;
          setRoomNotice("Item sent.");
          window.setTimeout(() => composerRef.current?.focus(), 0);
        } else {
          markNewDrop(payload.drop.id);
          setRoomNotice("New item received from another device.");
        }
      },
      onDropUpdated(payload) {
        const origin: DropOrigin = payload.by === clientIdRef.current ? "self" : "remote";
        const origins = { ...dropOriginsRef.current, [payload.drop.id]: origin };
        classifyDrops(sortDrops([
          payload.drop,
          ...dropsRef.current.filter((drop) => drop.id !== payload.drop.id && !drop.id.startsWith("legacy-live-")),
        ]), origins);
        if (origin === "self") {
          setRoomNotice("Item edited.");
        } else {
          markNewDrop(payload.drop.id);
          setRoomNotice("Item edited on another device.");
        }
      },
      onDropsRemoved(payload) {
        const removed = new Set(payload.dropIds);
        const nextDrops = dropsRef.current.filter((drop) => !removed.has(drop.id));
        const origins = Object.fromEntries(Object.entries(dropOriginsRef.current).filter(([id]) => !removed.has(id)));
        classifyDrops(nextDrops, origins);
      },
      onDropDeleted(payload) {
        const nextDrops = dropsRef.current.filter((drop) => drop.id !== payload.dropId);
        const origins = { ...dropOriginsRef.current };
        delete origins[payload.dropId];
        classifyDrops(nextDrops, origins);
        setRoomNotice("Item deleted.");
      },
      onDropsCleared() {
        clearDropHighlights();
        dropOriginsRef.current = {};
        setDropOrigins({});
        replaceDrops([]);
        setIsClearing(false);
        setRoomNotice("Clipboard cleared.");
      },
      onPresence(payload) {
        setPresenceCount(payload.count);
      },
      onLifecycle(payload) {
        setExpiresAfterMinutes(payload.expiresAfterMinutes);
        setRoomExpiresAt(payload.expiresAt);
        setPresenceCount(payload.presence);
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
        if (!payload.text || withoutLegacy[0]?.content === payload.text) {
          const origins = Object.fromEntries(
            Object.entries(dropOriginsRef.current).filter(([id]) => !id.startsWith(virtualPrefix)),
          );
          classifyDrops(withoutLegacy, origins);
          if (!payload.text && hadLegacy) {
            setRoomNotice("Legacy text cleared.");
          }
          return;
        }

        const virtual = legacyLiveDrop(payload.text, payload.version, dropTtlMinutesRef.current);
        const nextDrops = sortDrops([virtual, ...withoutLegacy]);
        const origins = {
          ...Object.fromEntries(
            Object.entries(dropOriginsRef.current).filter(([id]) => !id.startsWith(virtualPrefix)),
          ),
          [virtual.id]: "remote" as DropOrigin,
        };
        classifyDrops(nextDrops, origins);
        markNewDrop(virtual.id);
        setRoomNotice("Text received from an older client.");
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
  }, [clearDropHighlights, clearRoomUrl, classifyDrops, markNewDrop, replaceDrops, resetRoomData, roomCode]);

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
    if (newDropTimerRef.current !== null) {
      window.clearTimeout(newDropTimerRef.current);
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
    ? "Connected"
    : badgeVariant === "closed"
      ? "Disconnected"
      : badgeVariant === "reconnecting"
        ? "Reconnecting"
        : "Connecting";
  const presenceLabel = presenceCount === null
    ? null
    : formatRoomPresence(presenceCount);
  const expiryLabel = expiresAfterMinutes === null
    ? null
    : formatRoomExpiry({
      expiresAfterMinutes,
      expiresAt: roomExpiresAt,
      presence: presenceCount ?? 0,
    }, new Date(now));
  const dropPolicyLabel = dropExpiresAfterMinutes === null
    ? null
    : `Items last ${dropExpiresAfterMinutes >= 60 && dropExpiresAfterMinutes % 60 === 0 ? `${dropExpiresAfterMinutes / 60}h` : `${dropExpiresAfterMinutes} min`}${maxDrops ? ` · up to ${maxDrops}` : ""}.`;
  if (!roomCode) {
    const primaryJoinLabel = isJoining ? "Opening…" : "Open";
    return (
      <main className="quickdrop-text-shell">
        <section className="quickdrop-text-card quickdrop-text-join">
          <div className="quickdrop-text-heading">
            <p className="quickdrop-text-kicker">Text across devices</p>
            <h1>Temporary clipboard</h1>
            <p className="quickdrop-text-copy">
              Enter the same code on both devices. QuickDrop creates it if it does not exist.
            </p>
          </div>

          {errorMessage ? <p className="quickdrop-text-note quickdrop-text-note--error" role="alert">{errorMessage}</p> : null}

          <label className="quickdrop-text-field">
            <span>Enter a code</span>
            <input
              className="quickdrop-text-input"
              autoComplete="off"
              autoFocus
              inputMode="text"
              maxLength={16}
              placeholder="E.g. A, DEV, or SERVER-1"
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
                <span>{pinRequired ? "Room PIN" : "PIN (optional)"}</span>
                <input
                  className="quickdrop-text-input"
                  autoComplete="off"
                  type="password"
                  maxLength={64}
                  placeholder={pinRequired ? "Enter the PIN" : "Protect the clipboard if needed"}
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
                {isJoining ? "Generating…" : "Generate random code"}
              </button>
            </>
          ) : null}

          <p className="quickdrop-text-copy">
            Short codes are public and easy to guess. Do not use them for passwords or sensitive data.
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
              {showPrivacyOptions ? "Hide privacy" : "Privacy options"}
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
            <button className="quickdrop-text-icon-button" type="button" onClick={leaveRoom}>← Back</button>
            <div>
              <p className="quickdrop-text-kicker">Active clipboard</p>
              <div className="quickdrop-text-room-code-row">
                <h1 className="quickdrop-text-room-code">{roomCode}</h1>
                <button className="quickdrop-text-button quickdrop-text-button--primary" type="button" disabled={drops.length === 0} onClick={handleCopyLatest}>
                  Copy latest
                </button>
                <button className="quickdrop-text-button" type="button" onClick={handleCopyRoomLink}>Share address</button>
                <button className="quickdrop-text-button quickdrop-text-button--ghost" type="button" onClick={handleCopyCode}>Copy code</button>
                <button
                  className="quickdrop-text-button quickdrop-text-button--ghost"
                  type="button"
                  disabled={isClearing || drops.length === 0 || connectionPhase !== "open" || !snapshotReady}
                  onClick={handleClearDrops}
                >
                  {isClearing ? "Clearing…" : "Clear all"}
                </button>
                <button className="quickdrop-text-button" type="button" disabled={exportState.status === "uploading" || drops.length === 0} onClick={handleExportDrops}>
                  {exportState.status === "uploading" ? "Uploading…" : "Upload timeline as file"}
                </button>
              </div>
              {presenceLabel ? <p className="quickdrop-text-room-presence">{presenceLabel}</p> : null}
              {expiryLabel ? <p className="quickdrop-text-room-presence">{expiryLabel}{roomKind === "custom" ? " Public code." : ""}</p> : null}
              {dropPolicyLabel ? <p className="quickdrop-text-room-presence">{dropPolicyLabel}</p> : null}
            </div>
          </div>
          <span
            className={`quickdrop-text-badge quickdrop-text-badge--${badgeVariant ?? "closed"}`}
            role="status"
            aria-live="polite"
            aria-label={`Connection status: ${statusLabel}`}
          >
            {statusLabel}
          </span>
        </header>

        {roomNotice ? <p className="quickdrop-text-note quickdrop-text-note--success" aria-live="polite" aria-atomic="true">{roomNotice}</p> : null}
        {errorMessage ? <p className="quickdrop-text-note quickdrop-text-note--error" role="alert">{errorMessage}</p> : null}
        {exportState.status === "error" ? <p className="quickdrop-text-note quickdrop-text-note--error" role="alert">{exportState.message}</p> : null}
        {exportState.status === "success" ? (
          <p className="quickdrop-text-note quickdrop-text-note--success">
            {exportState.copied ? "Timeline uploaded. Link copied." : <>Timeline uploaded. <a href={exportState.url} target="_blank" rel="noreferrer">Open link</a></>}
          </p>
        ) : null}

        <section className="quickdrop-drop-composer" aria-labelledby="quickdrop-drop-composer-title">
          <div>
            <p className="quickdrop-text-kicker">New item</p>
            <h2 id="quickdrop-drop-composer-title">Paste once, keep the history</h2>
          </div>
          <label className="sr-only" htmlFor="quickdrop-drop-content">New item text</label>
          <textarea
            ref={composerRef}
            id="quickdrop-drop-content"
            className="quickdrop-drop-composer-input"
            value={composer}
            onChange={(event) => {
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
            placeholder="Type or paste text, a URL, a command, or JSON…"
            aria-describedby="quickdrop-drop-shortcuts"
            aria-keyshortcuts="Control+Enter Meta+Enter"
          />
          <div className="quickdrop-drop-composer-footer">
            <p id="quickdrop-drop-shortcuts">Ctrl/⌘ + Enter to send · Esc to leave</p>
            <button
              className="quickdrop-text-button quickdrop-text-button--primary"
              type="button"
              disabled={!composer.trim() || isPublishing || connectionPhase !== "open" || !snapshotReady}
              onClick={() => publishDrop()}
            >
              {isPublishing ? "Sending…" : "Send item"}
            </button>
          </div>
        </section>

        <section className="quickdrop-drop-timeline" aria-labelledby="quickdrop-drop-timeline-title">
          <div className="quickdrop-drop-timeline-heading">
            <div>
              <p className="quickdrop-text-kicker">History</p>
              <h2 id="quickdrop-drop-timeline-title">{drops.length} {drops.length === 1 ? "item" : "items"}</h2>
            </div>
          </div>

          {drops.length === 0 ? (
            <div className="quickdrop-drop-empty">
              <p>No items yet.</p>
              <span>Send the first text above and open this code on the other device.</span>
            </div>
          ) : (
            <ol className="quickdrop-drop-list">
              {drops.map((drop) => (
                <li
                  key={drop.id}
                  className={`quickdrop-drop-card${latestRemoteDropId === drop.id ? " quickdrop-drop-card--remote" : ""}${newDropId === drop.id ? " quickdrop-drop-card--new" : ""}`}
                >
                  <div className="quickdrop-drop-card-header">
                    <div className="quickdrop-drop-card-labels">
                      <span className={`quickdrop-drop-type quickdrop-drop-type--${drop.contentType}`}>{dropContentTypeLabel(drop.contentType)}</span>
                      {dropOrigins[drop.id] === "self" ? <span className="quickdrop-drop-origin quickdrop-drop-origin--self" aria-label={dropOriginLabel("self")}>YOU</span> : null}
                      {dropOrigins[drop.id] === "remote" ? <span className="quickdrop-drop-origin quickdrop-drop-origin--remote" aria-label={dropOriginLabel("remote")}>OTHER DEVICE</span> : null}
                      {newDropId === drop.id ? <span className="quickdrop-drop-origin quickdrop-drop-origin--new" aria-label="New item">NEW</span> : null}
                    </div>
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
                    <button className="quickdrop-text-button quickdrop-text-button--primary" type="button" onClick={() => void handleCopyDrop(drop)}>Copy</button>
                    <button className="quickdrop-text-button" type="button" disabled={connectionPhase !== "open" || !snapshotReady || isPublishing} onClick={() => publishDrop(drop.content, false)}>Send again</button>
                    <button className="quickdrop-text-button quickdrop-text-button--ghost" type="button" disabled={connectionPhase !== "open" || !snapshotReady || drop.id.startsWith("legacy-")} onClick={() => handleDeleteDrop(drop)}>Delete</button>
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
