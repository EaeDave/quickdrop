import { useCallback, useEffect, useState } from "react";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { copyLink, notifySuccess, onUploadProgress, selectLocalFiles, uploadFiles } from "./tauri";

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
    void getCurrentWindow().close();
  }, []);

  const handlePathDrop = useCallback(async (paths: string[]) => {
    setManualUrl(null);

    const selectedPaths = paths.filter(Boolean);

    if (selectedPaths.length === 0) {
      setState({ status: "error", message: "Selecione pelo menos um arquivo." });
      return;
    }

    setState({
      status: "uploading",
      fileName: formatSelectionName(selectedPaths),
      fileCount: selectedPaths.length,
      percent: 0,
      phase: selectedPaths.length === 1 ? "uploading" : "preparing",
    });

    try {
      const response = await uploadFiles(selectedPaths);

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
        await notifySuccess(selectedPaths.length);
        setState({ status: "success", url: response.url, expiresAt: response.expiresAt, fileCount: selectedPaths.length });
      } catch (error) {
        setState({
          status: "success",
          url: response.url,
          expiresAt: response.expiresAt,
          fileCount: selectedPaths.length,
          notificationWarning: `Link copiado, mas a notificação falhou: ${formatError(error)}`,
        });
      }
    } catch (error) {
      setState({ status: "error", message: formatError(error) });
    }
  }, []);

  const handlePickFile = useCallback(async () => {
    try {
      const paths = await selectLocalFiles();

      if (paths.length === 0) {
        return;
      }

      await handlePathDrop(paths);
    } catch (error) {
      setState({ status: "error", message: `Falha ao abrir seletor de arquivos: ${formatError(error)}` });
    }
  }, [handlePathDrop]);

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
        void handlePathDrop(event.payload.paths);
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
  }, [handlePathDrop]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        closeWindow();
      }
    };

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [closeWindow]);

  return (
    <main className="quickdrop-shell">
      <section className={`quickdrop-panel ${dropActive ? "quickdrop-panel--active" : ""}`} aria-label="QuickDrop">
        <header className="quickdrop-header">
          <h1 className="quickdrop-title">QuickDrop</h1>
          <button className="quickdrop-close" type="button" aria-label="Fechar QuickDrop" onClick={closeWindow}>
            ×
          </button>
        </header>

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

function formatSelectionName(paths: string[]): string {
  if (paths.length === 1) {
    return getFileName(paths[0] ?? "");
  }

  return `${paths.length} arquivos (.zip)`;
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
