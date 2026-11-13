import { type ChangeEvent, type DragEvent, type ReactNode, useCallback, useEffect, useRef, useState } from "react";
import { copyLink, onUploadProgress, uploadFiles } from "./browser";

type InstallPlatform = "windows" | "macos" | "linux";

const INSTALL_PLATFORMS: Record<InstallPlatform, { label: string; prompt: string; scriptHref: string }> = {
  windows: { label: "Windows", prompt: "PS", scriptHref: "/install.ps1" },
  macos: { label: "macOS", prompt: "$", scriptHref: "/install-macos.sh" },
  linux: { label: "Linux", prompt: "$", scriptHref: "/install.sh" },
};

type UploadState =
  | { status: "idle" }
  | { status: "uploading"; fileName: string; fileCount: number; percent: number; phase: "preparing" | "uploading" }
  | { status: "success"; url: string; expiresAt: string; fileCount: number }
  | { status: "error"; message: string };

export function App() {
  const [state, setState] = useState<UploadState>({ status: "idle" });
  const [manualUrl, setManualUrl] = useState<string | null>(null);
  const [dropActive, setDropActive] = useState(false);
  const [copiedInstallCommand, setCopiedInstallCommand] = useState(false);
  const [installCopyError, setInstallCopyError] = useState<string | null>(null);
  const copiedInstallTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const reset = useCallback(() => {
    setManualUrl(null);
    setState({ status: "idle" });
  }, []);

  const fileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
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

  const handleUploadInputs = useCallback(async (inputs: File[]) => {
    setManualUrl(null);

    const selectedInputs = inputs.filter(Boolean);

    if (selectedInputs.length === 0) {
      setState({ status: "error", message: "Select at least one file." });
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
          message: `Upload complete, but the link could not be copied: ${formatError(error)}`,
        });
        return;
      }

      setState({ status: "success", url: response.url, expiresAt: response.expiresAt, fileCount: selectedInputs.length });
    } catch (error) {
      setState({ status: "error", message: formatError(error) });
    }
  }, []);

  const handlePickFile = useCallback(() => {
    fileInputRef.current?.click();
  }, []);

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
      setInstallCopyError(`Could not copy automatically: ${formatError(error)}`);
    }
  }, []);

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
      console.error("Failed to register upload progress", error);
    });

    return () => {
      disposed = true;
      unlisten?.();
    };
  }, []);

  const handleDragOver = useCallback((event: DragEvent) => {
    event.preventDefault();
    setDropActive(true);
  }, []);

  const handleDragLeave = useCallback((event: DragEvent) => {
    event.preventDefault();
    setDropActive(false);
  }, []);

  const handleDrop = useCallback((event: DragEvent) => {
    event.preventDefault();
    setDropActive(false);
    const files = event.dataTransfer.files ? Array.from(event.dataTransfer.files) : [];
    if (files.length > 0) {
      void handleUploadInputs(files);
    }
  }, [handleUploadInputs]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        reset();
      }
    };

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [reset]);
  useEffect(() => {
    const handlePaste = (event: ClipboardEvent) => {
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

function IdleState(props: { onPickFile: () => void }) {
  return (
    <div className="quickdrop-drop-zone">
      <button
        className="quickdrop-picker"
        type="button"
        aria-label="Select files from this computer"
        title="Select files"
        onClick={props.onPickFile}
      >
        <span className="quickdrop-icon" aria-hidden="true">⇪</span>
      </button>
      <p className="quickdrop-primary">Drop files to send</p>
      <p className="quickdrop-secondary">Multiple files become one ZIP with a single link.</p>
    </div>
  );
}

function UploadingState(props: { state: Extract<UploadState, { status: "uploading" }> }) {
  const isPreparing = props.state.phase === "preparing";

  return (
    <div className="quickdrop-drop-zone">
      <p className="quickdrop-kicker">{isPreparing ? "Creating ZIP…" : "Uploading..."}</p>
      <p className="quickdrop-file">{props.state.fileName}</p>
      <div className="quickdrop-progress" aria-hidden="true">
        <div style={{ width: `${props.state.percent}%` }} />
      </div>
      <p className="quickdrop-secondary">
        {isPreparing
          ? "Compressing before upload"
          : props.state.fileCount === 1
            ? `${props.state.percent}% uploaded`
            : `${props.state.percent}% of package uploaded`}
      </p>
    </div>
  );
}

function SuccessState(props: { state: Extract<UploadState, { status: "success" }> }) {
  return (
    <div className="quickdrop-drop-zone quickdrop-state">
      <p className="quickdrop-primary quickdrop-success">Upload complete</p>
      <p className="quickdrop-secondary">
        {props.state.fileCount === 1 ? "Link copied" : `${props.state.fileCount} files in one link`}
      </p>
      <a className="quickdrop-url" href={props.state.url} tabIndex={-1} draggable={false}>
        {props.state.url}
      </a>
      <p className="quickdrop-meta">Expires {new Date(props.state.expiresAt).toLocaleString()}</p>
    </div>
  );
}

function ErrorState(props: { message: string; manualUrl: string | null; onReset: () => void }) {
  return (
    <div className="quickdrop-drop-zone quickdrop-state">
      <p className="quickdrop-primary quickdrop-error">Upload failed</p>
      <p className="quickdrop-message">{props.message}</p>
      {props.manualUrl && (
        <a className="quickdrop-url" href={props.manualUrl} tabIndex={-1} draggable={false}>
          {props.manualUrl}
        </a>
      )}
      <button className="quickdrop-action" type="button" onClick={props.onReset}>
        Try again
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
          <p className="quickdrop-pill">QuickDrop for Windows, macOS, and Linux</p>
          <h1 id="quickdrop-hero-title">Send files fast, copy the link, move on.</h1>
          <p className="quickdrop-hero-copy">
            Desktop app for Windows, macOS, and Linux with a production-ready backend. Install it with PowerShell or Bash, or use the web uploader below.
          </p>
          <InstallCommand
            copied={props.copiedInstallCommand}
            error={props.installCopyError}
            onCopy={props.onCopyInstallCommand}
          />
        </section>

        <section
          className={`quickdrop-web-upload quickdrop-panel ${props.dropActive ? "quickdrop-panel--active" : ""}`}
          aria-label="Send files from your browser"
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
  const baseUrl = window.location.origin.replace(/\/+$/, "");
  const command = platform === "windows"
    ? `irm ${baseUrl}${active.scriptHref} | iex`
    : `curl -fsSL ${baseUrl}${active.scriptHref} | bash`;

  return (
    <div className="quickdrop-install-card">
      <div className="quickdrop-install-header">
        <div className="quickdrop-install-tabs" role="tablist" aria-label="Platforms">
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
          View script
        </a>
      </div>
      <button className="quickdrop-command" type="button" onClick={() => props.onCopy(command)}>
        <span className="quickdrop-command-prompt">{active.prompt}</span>
        <code>{command}</code>
        <span className="quickdrop-command-copy">{props.copied ? "Copied" : "Copy"}</span>
      </button>
      {props.error && <p className="quickdrop-install-error">{props.error}</p>}
    </div>
  );
}

function formatSelectionName(inputs: File[]): string {
  if (inputs.length === 1) {
    return inputs[0]!.name;
  }

  return `${inputs.length} files (.zip)`;
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

  return "Unknown error.";
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
