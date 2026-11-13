import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { unzipSync } from "fflate";
import { onUploadProgress, uploadFiles } from "./browser";

const originalXhr = Object.getOwnPropertyDescriptor(globalThis, "XMLHttpRequest");
const response = { id: "drop", url: "https://quickdrop.example/drop", expiresAt: "2026-11-14T00:00:00Z" };
const requests: UploadRequest[] = [];
let reply = { status: 200, body: JSON.stringify(response), networkError: false };

class UploadRequest {
  upload = { onprogress: null as ((event: ProgressEvent) => void) | null };
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  status = reply.status;
  statusText = "Unavailable";
  responseText = reply.body;
  method = "";
  url = "";
  headers = new Map<string, string>();
  body: FormData | null = null;

  constructor() {
    requests.push(this);
  }

  open(method: string, url: string) {
    this.method = method;
    this.url = url;
  }

  setRequestHeader(name: string, value: string) {
    this.headers.set(name, value);
  }

  send(body: FormData) {
    this.body = body;
    this.upload.onprogress?.({ lengthComputable: true, loaded: 1, total: 2 } as ProgressEvent);
    if (reply.networkError) this.onerror?.();
    else this.onload?.();
  }
}

beforeEach(() => {
  requests.length = 0;
  reply = { status: 200, body: JSON.stringify(response), networkError: false };
  Object.defineProperty(globalThis, "XMLHttpRequest", { configurable: true, value: UploadRequest });
});

afterEach(() => {
  if (originalXhr) Object.defineProperty(globalThis, "XMLHttpRequest", originalXhr);
  else Reflect.deleteProperty(globalThis, "XMLHttpRequest");
});

describe("browser uploads", () => {
  test("posts files to the same-origin upload route and reports progress", async () => {
    const progress: number[] = [];
    const unsubscribe = await onUploadProgress((event) => progress.push(event.percent));
    try {
      const file = new File(["hello"], "hello.txt", { type: "text/plain" });
      expect(await uploadFiles([file])).toEqual(response);
      const request = requests[0]!;
      expect(request.method).toBe("POST");
      expect(request.url).toBe("/api/upload");
      expect(request.headers.get("x-quickdrop-file-size")).toBe("5");
      expect(await (request.body!.get("file") as File).text()).toBe("hello");
      expect(progress).toEqual([50]);
    } finally {
      unsubscribe();
    }
  });

  test("keeps duplicate file names distinct in a ZIP", async () => {
    await uploadFiles([new File(["first"], "note.txt"), new File(["second"], "note.txt")]);
    const archive = requests[0]!.body!.get("file") as File;
    expect(archive.name).toBe("quickdrop-2-files.zip");
    expect(archive.type).toBe("application/zip");
    const entries = unzipSync(new Uint8Array(await archive.arrayBuffer()));
    expect(Object.keys(entries).sort()).toEqual(["note-2.txt", "note.txt"]);
    const decoder = new TextDecoder();
    expect(decoder.decode(entries["note.txt"])).toBe("first");
    expect(decoder.decode(entries["note-2.txt"])).toBe("second");
  });

  test("rejects empty selections before making a request", async () => {
    await expect(uploadFiles([])).rejects.toThrow("No files selected.");
    expect(requests).toHaveLength(0);
  });

  test.each([
    [{ status: 503, body: "Storage unavailable", networkError: false }, "Storage unavailable"],
    [{ status: 200, body: "not json", networkError: false }, "Invalid server response."],
    [{ status: 0, body: "", networkError: true }, "Server connection failed."],
  ] as const)("preserves upload errors (%j)", async (result, message) => {
    reply = result;
    await expect(uploadFiles([new File(["hello"], "hello.txt")])).rejects.toThrow(message);
  });
});
