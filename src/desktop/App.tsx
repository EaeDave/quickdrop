import { type ChangeEvent, type DragEvent, type MouseEvent, type ReactNode, useCallback, useEffect, useRef, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { copyLink, dismissWindow, notifySuccess, onUploadProgress, readClipboardUploadInputs, selectLocalFiles, setupDesktopUpdater, uploadFiles, isTauri, usesNativeClipboardPaste, type UploadInput } from "./tauri";
import QuickPanel from "./QuickPanel";

const WINDOWS_INSTALL_COMMAND = "irm https://quickdrop.eaedave.xyz/install.ps1 | iex";
const MACOS_INSTALL_COMMAND = "curl -fsSL https://quickdrop.eaedave.xyz/install-macos.sh | bash";
const LINUX_INSTALL_COMMAND = "curl -fsSL https://quickdrop.eaedave.xyz/install.sh | bash";

type InstallPlatform = "windows" | "macos" | "linux";
type PanelMode = "files" | "text";

const INSTALL_PLATFORMS: Record<InstallPlatform, { label: string; prompt: string; command: string; scriptHref: string }> = {
  windows: { label: "Windows", prompt: "PS", command: WINDOWS_INSTALL_COMMAND, scriptHref: "/install.ps1" },
  macos: { label: "macOS", prompt: "$", command: MACOS_INSTALL_COMMAND, scriptHref: "/install-macos.sh" },
  linux: { label: "Linux", prompt: "$", command: LINUX_INSTALL_COMMAND, scriptHref: "/install.sh" },
};

type UploadState =
  | { status: "idle" }
  | { status: "uploading"; fileName: string; fileCount: number; percent: number; phase: "preparing" | "uploading" }
  | { status: "success"; url: string; expiresAt: string; fileCount: number; notificationWarning?: string }
  | { status: "error"; message: string };

export function App() {
  const [panelMode, setPanelMode] = useState<PanelMode>("files");
  const [state, setState] = useState<UploadState>({ status: "idle" });
  const [manualUrl, setManualUrl] = useState<string | null>(null);
  const [dropActive, setDropActive] = useState(false);
  const [useNativeClipboardPaste, setUseNativeClipboardPaste] = useState(false);
  const [copiedInstallCommand, setCopiedInstallCommand] = useState(false);
  const [installCopyError, setInstallCopyError] = useState<string | null>(null);
  const stateRef = useRef(state);
  const panelModeRef = useRef(panelMode);
  const copiedInstallTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const reset = useCallback(() => {
    setManualUrl(null);
    setState({ status: "idle" });
  }, []);

  const closeWindow = useCallback(() => {
    if (isTauri) {
      void dismissWindow();
    } else {
      reset();
    }
  }, [reset]);

  const startWindowDrag = useCallback((event: MouseEvent<HTMLElement>) => {
    if (!isTauri || event.button !== 0 || (event.target as HTMLElement).closest("button")) {
      return;
    }

    void getCurrentWindow().startDragging();
  }, []);

  const fileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (isTauri) {
      return;
    }

    document.documentElement.classList.add("quickdrop-web-page");
    return () => document.documentElement.classList.remove("quickdrop-web-page");
  }, []);

  useEffect(() => {
    return () => {
      if (copiedInstallTimeoutRef.current) {
        clearTimeout(copiedInstallTimeoutRef.current);
      }
    };
  }, []);

  useEffect(() => {
    stateRef.current = state;
  }, [state]);

  useEffect(() => {
    panelModeRef.current = panelMode;
  }, [panelMode]);

  useEffect(() => setupDesktopUpdater(), []);

  useEffect(() => {
    if (!isTauri) {
      return;
    }

    let disposed = false;

    usesNativeClipboardPaste().then((enabled) => {
      if (!disposed) {
        setUseNativeClipboardPaste(enabled);
      }
    }).catch((error) => {
      console.error("Falha ao detectar modo de clipboard nativo", error);
    });

    return () => {
      disposed = true;
    };
  }, []);

  const handleUploadInputs = useCallback(async (inputs: UploadInput[]) => {
    setManualUrl(null);

    const selectedInputs = inputs.filter(Boolean);

    if (selectedInputs.length === 0) {
      setState({ status: "error", message: "Selecione pelo menos um arquivo." });
      return;
    }

    setState({
      status: "uploading",
      fileName: formatSelectionName(selectedInputs),
      fileCount: selectedInputs.length,
      percent: 0,
      phase: selectedInputs.length === 1 ? "uploading" : "preparing",
    });

    try {
      const response = await uploadFiles(selectedInputs);

      try {
        await copyLink(response.url);
      } catch (error) {
        setManualUrl(response.url);
        setState({
          status: "error",
          message: `Upload concluído, mas não foi possível copiar o link: ${formatError(error)}`,
        });
        return;
      }

      try {
        await notifySuccess(selectedInputs.length);
        setState({ status: "success", url: response.url, expiresAt: response.expiresAt, fileCount: selectedInputs.length });
      } catch (error) {
        setState({
          status: "success",
          url: response.url,
          expiresAt: response.expiresAt,
          fileCount: selectedInputs.length,
          notificationWarning: `Link copiado, mas a notificação falhou: ${formatError(error)}`,
        });
      }
    } catch (error) {
      setState({ status: "error", message: formatError(error) });
    }
  }, []);

  const handlePickFile = useCallback(async () => {
    if (isTauri) {
      try {
        const paths = await selectLocalFiles();

        if (paths.length === 0) {
          return;
        }

        await handleUploadInputs(paths);
      } catch (error) {
        setState({ status: "error", message: `Falha ao abrir seletor de arquivos: ${formatError(error)}` });
      }
    } else {
      fileInputRef.current?.click();
    }
  }, [handleUploadInputs]);

  const handleFileInputChange = useCallback((event: ChangeEvent<HTMLInputElement>) => {
    const files = event.target.files ? Array.from(event.target.files) : [];
    if (files.length > 0) {
      void handleUploadInputs(files);
    }
    // Clear the input value so the same files can be selected again
    if (fileInputRef.current) {
      fileInputRef.current.value = "";
    }
  }, [handleUploadInputs]);

  const copyInstallCommand = useCallback(async (command: string) => {
    try {
      await copyTextToClipboard(command);
      setInstallCopyError(null);
      setCopiedInstallCommand(true);

      if (copiedInstallTimeoutRef.current) {
        clearTimeout(copiedInstallTimeoutRef.current);
      }

      copiedInstallTimeoutRef.current = setTimeout(() => {
        setCopiedInstallCommand(false);
        copiedInstallTimeoutRef.current = null;
      }, 1600);
    } catch (error) {
      setInstallCopyError(`Não foi possível copiar automaticamente: ${formatError(error)}`);
    }
  }, []);

  const handleNativeClipboardPaste = useCallback(async () => {
    if (!isTauri || panelModeRef.current !== "files" || stateRef.current.status === "uploading") {
      return;
    }

    try {
      const inputs = await readClipboardUploadInputs();

      if (inputs.length === 0) {
        setState({ status: "error", message: "Clipboard sem imagem ou texto para enviar." });
        return;
      }

      await handleUploadInputs(inputs);
    } catch (error) {
      setState({ status: "error", message: `Falha ao ler clipboard: ${formatError(error)}` });
    }
  }, [handleUploadInputs]);


  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let disposed = false;

    onUploadProgress((progress) => {
      setState((current) => {
        if (current.status !== "uploading") {
          return current;
        }

        return { ...current, phase: "uploading", percent: Math.min(100, Math.max(0, progress.percent)) };
      });
    }).then((cleanup) => {
      if (disposed) {
        cleanup();
        return;
      }

      unlisten = cleanup;
    }).catch((error) => {
      console.error("Falha ao registrar progresso do upload", error);
    });

    return () => {
      disposed = true;
      unlisten?.();
    };
  }, []);

  useEffect(() => {
    if (!isTauri) {
      return;
    }
    let unlisten: (() => void) | undefined;
    let disposed = false;

    getCurrentWebview().onDragDropEvent((event) => {
      if (event.payload.type === "over") {
        setDropActive(true);
        return;
      }

      if (event.payload.type === "leave") {
        setDropActive(false);
        return;
      }

      if (event.payload.type === "drop") {
        setDropActive(false);
        void handleUploadInputs(event.payload.paths);
      }
    }).then((cleanup) => {
      if (disposed) {
        cleanup();
        return;
      }

      unlisten = cleanup;
    }).catch((error) => {
      setState({ status: "error", message: `Falha ao ativar drag-and-drop: ${formatError(error)}` });
    });

    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [handleUploadInputs]);

  const handleDragOver = useCallback((event: DragEvent) => {
    if (!isTauri) {
      event.preventDefault();
      setDropActive(true);
    }
  }, []);

  const handleDragLeave = useCallback((event: DragEvent) => {
    if (!isTauri) {
      event.preventDefault();
      setDropActive(false);
    }
  }, []);

  const handleDrop = useCallback((event: DragEvent) => {
    if (!isTauri) {
      event.preventDefault();
      setDropActive(false);
      const files = event.dataTransfer.files ? Array.from(event.dataTransfer.files) : [];
      if (files.length > 0) {
        void handleUploadInputs(files);
      }
    }
  }, [handleUploadInputs]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (isTauri && panelModeRef.current === "files" && useNativeClipboardPaste && isPasteShortcut(event)) {
        event.preventDefault();
        void handleNativeClipboardPaste();
        return;
      }

      if (event.key === "Escape") {
        closeWindow();
      }
    };

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [closeWindow, handleNativeClipboardPaste, useNativeClipboardPaste]);
  useEffect(() => {
    const handlePaste = (event: ClipboardEvent) => {
      if (panelModeRef.current !== "files") {
        return;
      }
      setState((current) => {
        if (current.status === "uploading") {
          return current;
        }

        const clipboardData = event.clipboardData;
        if (!clipboardData) return current;

        const files = clipboardData.files ? Array.from(clipboardData.files) : [];
        if (files.length > 0) {
          setTimeout(() => {
            void handleUploadInputs(files);
          }, 0);
          return current;
        }

        const text = clipboardData.getData("text");
        if (text && text.trim().length > 0) {
          const file = new File([text], "quickdrop-paste.txt", { type: "text/plain" });
          setTimeout(() => {
            void handleUploadInputs([file]);
          }, 0);
          return current;
        }

        return current;
      });
    };

    window.addEventListener("paste", handlePaste);
    return () => window.removeEventListener("paste", handlePaste);
  }, [handleUploadInputs]);

  const fileInput = (
    <input
      type="file"
      ref={fileInputRef}
      onChange={handleFileInputChange}
      multiple
      style={{ display: "none" }}
    />
  );

  const uploadState = (
    <>
      {state.status === "idle" && <IdleState onPickFile={handlePickFile} />}
      {state.status === "uploading" && <UploadingState state={state} />}
      {state.status === "success" && <SuccessState state={state} />}
      {state.status === "error" && <ErrorState message={state.message} manualUrl={manualUrl} onReset={reset} />}
    </>
  );

  if (!isTauri) {
    return (
      <WebLanding
        copiedInstallCommand={copiedInstallCommand}
        dropActive={dropActive}
        fileInput={fileInput}
        installCopyError={installCopyError}
        onCopyInstallCommand={copyInstallCommand}
        onDragLeave={handleDragLeave}
        onDragOver={handleDragOver}
        onDrop={handleDrop}
      >
        {uploadState}
      </WebLanding>
    );
  }

  return (
    <main className="quickdrop-shell">
      <section
        className={`quickdrop-panel ${dropActive ? "quickdrop-panel--active" : ""}`}
        aria-label="QuickDrop"
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
      >
        <header className="quickdrop-header" onMouseDown={startWindowDrag}>
          <h1 className="quickdrop-title">QuickDrop</h1>
          <nav className="quickdrop-mode-tabs" aria-label="Modo do QuickPanel">
            <button type="button" className={panelMode === "files" ? "quickdrop-mode-tab--active" : ""} onClick={() => setPanelMode("files")}>Arquivo</button>
            <button type="button" className={panelMode === "text" ? "quickdrop-mode-tab--active" : ""} onClick={() => setPanelMode("text")}>Texto</button>
          </nav>
          <button className="quickdrop-close" type="button" aria-label="Fechar QuickDrop" onClick={closeWindow}>
            ×
          </button>
        </header>
        {fileInput}
        <div className="quickdrop-mode-content" hidden={panelMode !== "files"}>{uploadState}</div>
        <div className="quickdrop-mode-content" hidden={panelMode !== "text"}><QuickPanel /></div>
      </section>
    </main>
  );
}

function IdleState(props: { onPickFile: () => void }) {
  return (
    <div className="quickdrop-drop-zone">
      <button
        className="quickdrop-picker"
        type="button"
        aria-label="Selecionar arquivos do computador"
        title="Selecionar arquivos"
        onClick={props.onPickFile}
      >
        <span className="quickdrop-icon" aria-hidden="true">⇪</span>
      </button>
      <p className="quickdrop-primary">Arraste arquivos para enviar</p>
      <p className="quickdrop-secondary">Múltiplos arquivos viram um ZIP com um único link.</p>
    </div>
  );
}

function UploadingState(props: { state: Extract<UploadState, { status: "uploading" }> }) {
  const isPreparing = props.state.phase === "preparing";

  return (
    <div className="quickdrop-drop-zone">
      <p className="quickdrop-kicker">{isPreparing ? "Criando ZIP..." : "Uploading..."}</p>
      <p className="quickdrop-file">{props.state.fileName}</p>
      <div className="quickdrop-progress" aria-hidden="true">
        <div style={{ width: `${props.state.percent}%` }} />
      </div>
      <p className="quickdrop-secondary">
        {isPreparing
          ? "Compactando antes do envio"
          : props.state.fileCount === 1
            ? `${props.state.percent}% enviado`
            : `${props.state.percent}% do pacote enviado`}
      </p>
    </div>
  );
}

function SuccessState(props: { state: Extract<UploadState, { status: "success" }> }) {
  return (
    <div className="quickdrop-drop-zone quickdrop-state">
      <p className="quickdrop-primary quickdrop-success">Upload concluído</p>
      <p className="quickdrop-secondary">
        {props.state.fileCount === 1 ? "Link copiado" : `${props.state.fileCount} arquivos em um único link`}
      </p>
      <a className="quickdrop-url" href={props.state.url} tabIndex={-1} draggable={false}>
        {props.state.url}
      </a>
      <p className="quickdrop-meta">Expira em {new Date(props.state.expiresAt).toLocaleString()}</p>
      {props.state.notificationWarning && <p className="quickdrop-warning">{props.state.notificationWarning}</p>}
    </div>
  );
}

function ErrorState(props: { message: string; manualUrl: string | null; onReset: () => void }) {
  return (
    <div className="quickdrop-drop-zone quickdrop-state">
      <p className="quickdrop-primary quickdrop-error">Falha no upload</p>
      <p className="quickdrop-message">{props.message}</p>
      {props.manualUrl && (
        <a className="quickdrop-url" href={props.manualUrl} tabIndex={-1} draggable={false}>
          {props.manualUrl}
        </a>
      )}
      <button className="quickdrop-action" type="button" onClick={props.onReset}>
        Tentar novamente
      </button>
    </div>
  );
}

function WebLanding(props: {
  children: ReactNode;
  copiedInstallCommand: boolean;
  dropActive: boolean;
  fileInput: ReactNode;
  installCopyError: string | null;
  onCopyInstallCommand: (command: string) => void;
  onDragLeave: (event: DragEvent) => void;
  onDragOver: (event: DragEvent) => void;
  onDrop: (event: DragEvent) => void;
}) {
  return (
    <main className="quickdrop-web">
      <div className="quickdrop-web-inner">
        <section className="quickdrop-hero" aria-labelledby="quickdrop-hero-title">
          <p className="quickdrop-pill">QuickDrop para Windows e Linux</p>
          <h1 id="quickdrop-hero-title">Envie arquivos rápido, copie o link e siga.</h1>
          <p className="quickdrop-hero-copy">
            App desktop com tray (Windows) e ícone na Waybar (Linux/Hyprland), backend de produção pronto. Instale pelo PowerShell ou Bash, ou use o upload web abaixo.
          </p>
          <InstallCommand
            copied={props.copiedInstallCommand}
            error={props.installCopyError}
            onCopy={props.onCopyInstallCommand}
          />
        </section>

        <section
          className={`quickdrop-web-upload quickdrop-panel ${props.dropActive ? "quickdrop-panel--active" : ""}`}
          aria-label="Enviar arquivos pelo navegador"
          onDragOver={props.onDragOver}
          onDragLeave={props.onDragLeave}
          onDrop={props.onDrop}
        >
          {props.fileInput}
          {props.children}
        </section>
      </div>
    </main>
  );
}

function InstallCommand(props: { copied: boolean; error: string | null; onCopy: (command: string) => void }) {
  const [platform, setPlatform] = useState<InstallPlatform>("windows");
  const active = INSTALL_PLATFORMS[platform];

  return (
    <div className="quickdrop-install-card">
      <div className="quickdrop-install-header">
        <div className="quickdrop-install-tabs" role="tablist" aria-label="Plataformas">
          {(Object.keys(INSTALL_PLATFORMS) as InstallPlatform[]).map((key) => (
            <button
              key={key}
              type="button"
              role="tab"
              aria-selected={platform === key}
              className={`quickdrop-install-tab ${platform === key ? "quickdrop-install-tab--active" : ""}`}
              onClick={() => setPlatform(key)}
            >
              {INSTALL_PLATFORMS[key].label}
            </button>
          ))}
        </div>
        <a className="quickdrop-install-script" href={active.scriptHref} target="_blank" rel="noreferrer">
          Ver script
        </a>
      </div>
      <button className="quickdrop-command" type="button" onClick={() => props.onCopy(active.command)}>
        <span className="quickdrop-command-prompt">{active.prompt}</span>
        <code>{active.command}</code>
        <span className="quickdrop-command-copy">{props.copied ? "Copiado" : "Copiar"}</span>
      </button>
      {props.error && <p className="quickdrop-install-error">{props.error}</p>}
    </div>
  );
}

function formatSelectionName(inputs: UploadInput[]): string {
  if (inputs.length === 1) {
    const input = inputs[0]!;
    if (typeof input === "string") return getFileName(input);
    if (input instanceof File) return input.name;
    return input.name ?? getFileName(input.path);
  }

  return `${inputs.length} arquivos (.zip)`;
}

function getFileName(path: string): string {
  return path.split(/[\\/]/).pop() || path;
}

function isPasteShortcut(event: KeyboardEvent): boolean {
  return (event.ctrlKey || event.metaKey) && !event.altKey && event.key.toLowerCase() === "v";
}

async function copyTextToClipboard(text: string): Promise<void> {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text);
    return;
  }

  const textArea = document.createElement("textarea");
  textArea.value = text;
  textArea.setAttribute("readonly", "true");
  textArea.style.position = "fixed";
  textArea.style.left = "-9999px";
  document.body.appendChild(textArea);
  textArea.select();

  try {
    const copied = document.execCommand("copy");
    if (!copied) {
      throw new Error("clipboard copy command failed");
    }
  } finally {
    textArea.remove();
  }
}

function formatError(error: unknown): string {
  if (typeof error === "string") {
    return extractBackendMessage(error);
  }

  if (error instanceof Error) {
    return error.message;
  }

  return "Erro desconhecido.";
}

function extractBackendMessage(raw: string): string {
  try {
    const parsed: unknown = JSON.parse(raw);

    if (parsed && typeof parsed === "object" && "message" in parsed && typeof parsed.message === "string") {
      return parsed.message;
    }
  } catch {
    return raw;
  }

  return raw;
}
