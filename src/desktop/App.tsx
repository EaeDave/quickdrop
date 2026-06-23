import { useCallback, useEffect, useRef, useState } from "react";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { copyLink, notifySuccess, onUploadProgress, selectLocalFiles, uploadFiles, isTauri, type UploadInput } from "./tauri";

type UploadState =
  | { status: "idle" }
  | { status: "uploading"; fileName: string; fileCount: number; percent: number; phase: "preparing" | "uploading" }
  | { status: "success"; url: string; expiresAt: string; fileCount: number; notificationWarning?: string }
  | { status: "error"; message: string };

export function App() {
  const [state, setState] = useState<UploadState>({ status: "idle" });
  const [manualUrl, setManualUrl] = useState<string | null>(null);
  const [dropActive, setDropActive] = useState(false);

  const reset = useCallback(() => {
    setManualUrl(null);
    setState({ status: "idle" });
  }, []);

  const closeWindow = useCallback(() => {
    if (isTauri) {
      void getCurrentWindow().close();
    } else {
      reset();
    }
  }, [reset]);

  const fileInputRef = useRef<HTMLInputElement>(null);

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

  const handleFileInputChange = useCallback((event: React.ChangeEvent<HTMLInputElement>) => {
    const files = event.target.files ? Array.from(event.target.files) : [];
    if (files.length > 0) {
      void handleUploadInputs(files);
    }
    // Clear the input value so the same files can be selected again
    if (fileInputRef.current) {
      fileInputRef.current.value = "";
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

  const handleDragOver = useCallback((event: React.DragEvent) => {
    if (!isTauri) {
      event.preventDefault();
      setDropActive(true);
    }
  }, []);

  const handleDragLeave = useCallback((event: React.DragEvent) => {
    if (!isTauri) {
      event.preventDefault();
      setDropActive(false);
    }
  }, []);

  const handleDrop = useCallback((event: React.DragEvent) => {
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
      if (event.key === "Escape") {
        closeWindow();
      }
    };

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [closeWindow]);
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

  return (
    <main className="quickdrop-shell">
      <section
        className={`quickdrop-panel ${dropActive ? "quickdrop-panel--active" : ""}`}
        aria-label="QuickDrop"
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
      >
        <header className="quickdrop-header">
          <h1 className="quickdrop-title">QuickDrop</h1>
          <button className="quickdrop-close" type="button" aria-label="Fechar QuickDrop" onClick={closeWindow}>
            ×
          </button>
        </header>
        <input
          type="file"
          ref={fileInputRef}
          onChange={handleFileInputChange}
          multiple
          style={{ display: "none" }}
        />

        {state.status === "idle" && <IdleState onPickFile={handlePickFile} />}
        {state.status === "uploading" && <UploadingState state={state} />}
        {state.status === "success" && <SuccessState state={state} />}
        {state.status === "error" && <ErrorState message={state.message} manualUrl={manualUrl} onReset={reset} />}
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

function formatSelectionName(inputs: UploadInput[]): string {
  if (inputs.length === 1) {
    const input = inputs[0]!;
    const name = typeof input === "string" ? getFileName(input) : input.name;
    return name;
  }

  return `${inputs.length} arquivos (.zip)`;
}

function getFileName(path: string): string {
  return path.split(/[\\/]/).pop() || path;
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
