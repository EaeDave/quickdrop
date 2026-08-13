export type TextShortcutEvent = {
  key: string;
  ctrlKey: boolean;
  metaKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
  isComposing: boolean;
};

export function isPublishDropShortcut(event: TextShortcutEvent): boolean {
  return (
    event.key === "Enter" &&
    (event.ctrlKey || event.metaKey) &&
    !event.altKey &&
    !event.shiftKey &&
    !event.isComposing
  );
}

export function dropContentTypeLabel(contentType: "text" | "url" | "command" | "json"): string {
  switch (contentType) {
    case "url":
      return "URL";
    case "command":
      return "Comando";
    case "json":
      return "JSON";
    default:
      return "Texto";
  }
}
