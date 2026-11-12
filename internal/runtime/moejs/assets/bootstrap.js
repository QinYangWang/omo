// Runtime shims installed before the Pi Durable bundle loads.
// moejs is not Node.js: it lacks FinalizationRegistry, `process` and a few
// other globals that npm packages assume. Each shim here is documented in
// COMPATIBILITY.md; none of them pretends to provide a capability the host
// does not have.
if (typeof globalThis.FinalizationRegistry === "undefined") {
  globalThis.FinalizationRegistry = class FinalizationRegistry {
    constructor(cleanup) {
      this._cleanup = cleanup;
    }
    register() {}
    unregister() {}
  };
}
if (typeof globalThis.process === "undefined") {
  const noop = () => {};
  globalThis.process = {
    env: {},
    platform: "linux",
    arch: "x64",
    versions: {},
    release: { name: "moejs" },
    argv: [],
    cwd: () => "/",
    nextTick: (fn, ...args) => queueMicrotask(() => fn(...args)),
    on: noop,
    once: noop,
    off: noop,
    removeListener: noop,
    emitWarning: noop,
    exit: (code) => {
      throw new Error("process.exit(" + code + ") is not supported");
    },
    stdout: { write: noop, isTTY: false },
    stderr: { write: noop, isTTY: false },
  };
}
if (typeof globalThis.crypto === "undefined") {
  // Randomness comes from the Go host (crypto/rand); see host.randomBytes.
  const fill = (view) => {
    const bytes = new Uint8Array(view.buffer, view.byteOffset, view.byteLength);
    const hex = globalThis.__host_random(bytes.length);
    for (let i = 0; i < bytes.length; i++) {
      bytes[i] = parseInt(hex.substr(i * 2, 2), 16);
    }
    return view;
  };
  globalThis.crypto = {
    getRandomValues(view) {
      return fill(view);
    },
    randomUUID() {
      const b = fill(new Uint8Array(16));
      b[6] = (b[6] & 0x0f) | 0x40;
      b[8] = (b[8] & 0x3f) | 0x80;
      const hex = Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
      return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
    },
  };
}
if (typeof globalThis.console === "undefined") {
  const emit = (level) => (...args) => {
    try {
      globalThis.__host_log(level, args.map((a) => (typeof a === "string" ? a : safeString(a))).join(" "));
    } catch {}
  };
  const safeString = (a) => {
    try {
      return JSON.stringify(a);
    } catch {
      return String(a);
    }
  };
  globalThis.console = {
    log: emit("info"),
    info: emit("info"),
    debug: emit("debug"),
    warn: emit("warn"),
    error: emit("error"),
  };
}
if (typeof globalThis.FormData === "undefined") {
  // The OpenAI SDK checks `body instanceof FormData` on every request. The
  // POC never sends multipart bodies, so a small stand-in is enough; any
  // attempt to actually upload returns the entries as a plain object.
  globalThis.FormData = class FormData {
    #entries = [];
    append(name, value) {
      this.#entries.push([String(name), value]);
    }
    set(name, value) {
      this.delete(name);
      this.append(name, value);
    }
    get(name) {
      const found = this.#entries.find(([k]) => k === String(name));
      return found ? found[1] : null;
    }
    getAll(name) {
      return this.#entries.filter(([k]) => k === String(name)).map(([, v]) => v);
    }
    has(name) {
      return this.#entries.some(([k]) => k === String(name));
    }
    delete(name) {
      this.#entries = this.#entries.filter(([k]) => k !== String(name));
    }
    entries() {
      return this.#entries[Symbol.iterator]();
    }
    keys() {
      return this.#entries.map(([k]) => k)[Symbol.iterator]();
    }
    values() {
      return this.#entries.map(([, v]) => v)[Symbol.iterator]();
    }
    [Symbol.iterator]() {
      return this.entries();
    }
  };
}
