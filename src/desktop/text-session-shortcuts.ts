export type TextShortcutEvent = {
  key: string;
  ctrlKey: boolean;
  metaKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
  isComposing: boolean;
};

export function isCopyTextShortcut(event: TextShortcutEvent): boolean {
  return (
    event.key === "Enter" &&
    (event.ctrlKey || event.metaKey) &&
    !event.altKey &&
    !event.shiftKey &&
    !event.isComposing
  );
}

export function remoteContentNotice(text: string): string {
  return text.length === 0
    ? "Clipboard limpo em outro dispositivo."
    : "Novo texto recebido de outro dispositivo.";
}
