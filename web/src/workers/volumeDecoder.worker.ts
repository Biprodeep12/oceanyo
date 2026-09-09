/// <reference lib="webworker" />

// Owns BOTH the fetch and the decode, so the main thread never touches the
// volume body. Parsing a multi-MB grid on the main thread is a visible frame
// drop in the middle of the extrude animation.
//
// The worker also owns the AbortController: an AbortSignal is not
// structured-cloneable, so cancellation has to be a message, not a transfer.

interface FetchMessage {
  type: "fetch";
  requestId: string;
  url: string;
}
interface AbortMessage {
  type: "abort";
  requestId: string;
}
type Incoming = FetchMessage | AbortMessage;

const inflight = new Map<string, AbortController>();

self.onmessage = async (ev: MessageEvent<Incoming>) => {
  const msg = ev.data;

  if (msg.type === "abort") {
    inflight.get(msg.requestId)?.abort();
    inflight.delete(msg.requestId);
    return;
  }

  const { requestId, url } = msg;
  const controller = new AbortController();
  inflight.set(requestId, controller);

  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) throw new Error(`volume fetch failed: ${res.status}`);
    const buf = await res.arrayBuffer();

    // Wire format: [uint32 LE headerLen][utf8 JSON header][raw volume bytes].
    // Mirrors backend/app/api/services/volume.py pack().
    const view = new DataView(buf);
    const headerLen = view.getUint32(0, true);
    const headerText = new TextDecoder().decode(new Uint8Array(buf, 4, headerLen));
    const header = JSON.parse(headerText);

    const body = buf.slice(4 + headerLen);
    const [nz, ny, nx] = header.dims as [number, number, number];
    const expected = nz * ny * nx * (header.dtype === "uint16" ? 2 : 1);
    if (body.byteLength !== expected) {
      throw new Error(
        `volume body ${body.byteLength} B does not match dims ${header.dims} ` +
          `(expected ${expected} B) -- likely a transposed or truncated volume`,
      );
    }

    inflight.delete(requestId);
    // Transferable: zero-copy handoff, the worker loses ownership of `body`.
    (self as unknown as Worker).postMessage(
      { type: "done", requestId, header, body },
      [body],
    );
  } catch (err) {
    inflight.delete(requestId);
    const aborted = (err as Error)?.name === "AbortError";
    (self as unknown as Worker).postMessage({
      type: aborted ? "aborted" : "error",
      requestId,
      message: (err as Error)?.message ?? String(err),
    });
  }
};

export {};
