import http from "node:http";
import https from "node:https";

// HTTP responses that must not carry a message body.
const BODYLESS_STATUSES = new Set([204, 205, 304]);

function toRequestUrl(input) {
  if (typeof input === "string") {
    return new URL(input);
  }
  if (input instanceof URL) {
    return input;
  }
  return new URL(input.url);
}

function toRequestHeaders(init) {
  const headers = new Headers();
  if (init?.headers) {
    for (const [key, value] of new Headers(init.headers)) {
      headers.set(key, value);
    }
  }
  return headers;
}

function toResponseHeaders(rawHeaders) {
  const headers = {};
  for (const [key, value] of Object.entries(rawHeaders)) {
    if (value !== undefined) {
      headers[key] = Array.isArray(value) ? value.join(", ") : value;
    }
  }
  return headers;
}

function nodeReadableToWeb(readable, request) {
  let cancelled = false;
  return new ReadableStream({
    cancel() {
      cancelled = true;
      readable.destroy();
      request.destroy();
    },
    start(controller) {
      readable.on("data", (chunk) => {
        if (!cancelled) {
          controller.enqueue(chunk);
        }
      });
      readable.on("end", () => {
        try {
          controller.close();
        } catch {
          // The consumer already cancelled the stream.
        }
      });
      readable.on("error", (error) => {
        if (!cancelled) {
          controller.error(error);
        }
      });
    },
  });
}

/**
 * Builds a `fetch`-compatible function that talks to a Host over a Unix
 * domain socket or a Windows named pipe. The shared `HttpHostClient` can use
 * it unchanged, so JSON requests and SSE streaming keep the same code path
 * as TCP. The adapter lives outside browser-facing `@omo/client-core` because
 * it depends on Node's `node:http`/`node:https`.
 *
 * The caller's `AbortSignal` is forwarded to `http.request`, so aborting an
 * SSE subscription destroys the underlying socket request.
 */
export function createLocalEndpointFetch(socketPath, { tls = false } = {}) {
  if (typeof socketPath !== "string" || socketPath.length === 0) {
    throw new Error("A local socket path or named pipe is required");
  }
  const request = tls ? https.request : http.request;
  return (input, init = {}) =>
    new Promise((resolve, reject) => {
      const url = toRequestUrl(input);
      const headers = toRequestHeaders(init);
      const clientRequest = request(
        {
          headers: Object.fromEntries(headers.entries()),
          method: init.method ?? "GET",
          path: `${url.pathname}${url.search}`,
          signal: init.signal,
          socketPath,
        },
        (response) => {
          const status = response.statusCode ?? 502;
          const body = BODYLESS_STATUSES.has(status)
            ? null
            : nodeReadableToWeb(response, clientRequest);
          resolve(
            new Response(body, {
              headers: toResponseHeaders(response.headers),
              status,
              statusText: response.statusMessage,
            })
          );
        }
      );
      clientRequest.once("error", reject);
      const { body } = init;
      if (typeof body === "string" || body instanceof Uint8Array) {
        clientRequest.end(body);
        return;
      }
      clientRequest.end();
    });
}
