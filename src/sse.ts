/**
 * Minimal SSE reader over fetch() streaming body (Node 18+).
 */

export type SseHandler = (eventName: string, data: string) => void | Promise<void>;

function parseSseBlock(block: string): { eventName: string; data: string } | null {
  const lines = block.split(/\r?\n/);
  let eventName = "message";
  const dataLines: string[] = [];
  for (const line of lines) {
    if (line.startsWith("event:")) {
      eventName = line.slice(6).trim();
    } else if (line.startsWith("data:")) {
      dataLines.push(line.slice(5).trimStart());
    }
  }
  if (dataLines.length === 0) {
    return null;
  }
  return { eventName, data: dataLines.join("\n") };
}

export async function consumeSseStream(params: {
  url: string;
  headers: Record<string, string>;
  signal: AbortSignal;
  onEvent: SseHandler;
  onError?: (err: unknown) => void;
}): Promise<void> {
  const res = await fetch(params.url, {
    method: "GET",
    headers: {
      Accept: "text/event-stream",
      ...params.headers,
    },
    signal: params.signal,
  });
  if (!res.ok) {
    throw new Error(`csgclaw SSE: HTTP ${res.status} ${res.statusText}`);
  }
  if (!res.body) {
    throw new Error("csgclaw SSE: empty body");
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";

  try {
    while (!params.signal.aborted) {
      const { value, done } = await reader.read();
      if (done) {
        break;
      }
      buf += decoder.decode(value, { stream: true });
      let idx: number;
      while ((idx = buf.indexOf("\n\n")) >= 0) {
        const block = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        const parsed = parseSseBlock(block);
        if (parsed) {
          const ret = params.onEvent(parsed.eventName, parsed.data);
          if (ret instanceof Promise) {
            await ret;
          }
        }
      }
    }
  } catch (err) {
    params.onError?.(err);
    throw err;
  } finally {
    reader.releaseLock();
  }
}
