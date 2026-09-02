type EventCallback = (data: { sessionId: string; event: any }) => void

declare global {
  interface Window { __OMO_SERVER_URL__?: string }
}

function normalizeBaseUrl(value: string) {
  return value.trim().replace(/\/$/, "")
}

export function getRemoteConfig() {
  return {
    url: normalizeBaseUrl(localStorage.getItem("omo:server-url") || window.__OMO_SERVER_URL__ || ""),
    token: localStorage.getItem("omo:server-token") || "",
  }
}

export function saveRemoteConfig(url: string, token: string) {
  if (url.trim()) localStorage.setItem("omo:server-url", normalizeBaseUrl(url))
  else localStorage.removeItem("omo:server-url")
  if (token) localStorage.setItem("omo:server-token", token)
  else localStorage.removeItem("omo:server-token")
}

export function createRemoteApi(baseUrl: string, token: string): OmoApi {
  const base = normalizeBaseUrl(baseUrl)
  const headers = () => ({
    "Content-Type": "application/json",
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  })
  const request = async <T>(route: string, init?: RequestInit): Promise<T> => {
    const response = await fetch(`${base}/api/v1${route}`, { ...init, headers: { ...headers(), ...init?.headers } })
    const result = await response.json().catch(() => ({}))
    if (!response.ok) throw new Error(result.error || `Server request failed (${response.status})`)
    return result as T
  }
  const post = <T>(route: string, value: unknown) => request<T>(route, { method: "POST", body: JSON.stringify(value) })
  const query = (values: Record<string, string>) => new URLSearchParams(values).toString()

  const piListeners = new Set<EventCallback>()
  const authListeners = new Set<(event: any) => void>()
  const streams = new Map<string, AbortController>()

  const connectEvents = (sessionId: string) => {
    if (streams.has(sessionId)) return
    const controller = new AbortController()
    streams.set(sessionId, controller)
    let retry = 1000

    const run = async () => {
      while (!controller.signal.aborted) {
        const sequenceKey = `omo:event-sequence:${base}:${sessionId}`
        const after = Number(localStorage.getItem(sequenceKey) || 0)
        try {
          const response = await fetch(`${base}/api/v1/events?${query({ sessionId, after: String(after) })}`, {
            headers: headers(), signal: controller.signal,
          })
          if (!response.ok || !response.body) throw new Error(`Event stream failed (${response.status})`)
          retry = 1000
          const reader = response.body.getReader()
          const decoder = new TextDecoder()
          let buffer = ""
          while (!controller.signal.aborted) {
            const { value, done } = await reader.read()
            if (done) break
            buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, "\n")
            let boundary = buffer.indexOf("\n\n")
            while (boundary >= 0) {
              const block = buffer.slice(0, boundary)
              buffer = buffer.slice(boundary + 2)
              const data = block.split("\n").filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trimStart()).join("\n")
              if (data) {
                const record = JSON.parse(data)
                localStorage.setItem(sequenceKey, String(record.sequence))
                if (sessionId === "__providers") {
                  const event = record.payload
                  if (event?.event?.type === "auth_url") window.open(event.event.url, "_blank", "noopener,noreferrer")
                  if (event?.event?.type === "device_code") window.open(event.event.verificationUri, "_blank", "noopener,noreferrer")
                  authListeners.forEach((listener) => listener(event))
                } else {
                  piListeners.forEach((listener) => listener({ sessionId, event: record.payload }))
                }
              }
              boundary = buffer.indexOf("\n\n")
            }
          }
        } catch (error) {
          if (controller.signal.aborted) break
          console.warn("Omo event stream reconnecting", error)
        }
        await new Promise((resolve) => setTimeout(resolve, retry + Math.random() * retry * 0.2))
        retry = Math.min(30000, retry * 2)
      }
    }
    void run()
  }

  return {
    pi: {
      open: async (sessionId, cwd, sessionPath) => {
        const result = await post<any>("/pi/open", { sessionId, cwd, sessionPath })
        const sequenceKey = `omo:event-sequence:${base}:${sessionId}`
        if (typeof result.eventSequence === "number" && !localStorage.getItem(sequenceKey)) {
          localStorage.setItem(sequenceKey, String(result.eventSequence))
        }
        connectEvents(sessionId)
        return result
      },
      history: (sessionId, before) => post("/pi/history", { sessionId, before }),
      models: () => request("/pi/models"),
      setModel: async (sessionId, provider, modelId) => { await post("/pi/model", { sessionId, provider, modelId }) },
      setThinking: async (sessionId, level) => { await post("/pi/thinking", { sessionId, level }) },
      prompt: async (sessionId, message, cwd, sessionPath) => { await post("/pi/prompt", { sessionId, message, cwd, sessionPath, requestId: crypto.randomUUID() }) },
      abort: async (sessionId) => { await post("/pi/abort", { sessionId }) },
      onEvent: (callback) => { piListeners.add(callback); return () => piListeners.delete(callback) },
    },
    term: {
      create: async () => { throw new Error("Remote terminal transport is not available yet") },
      input: () => undefined,
      onData: () => () => undefined,
    },
    fs: {
      list: (dir) => request(`/files?${query({ path: dir })}`),
      read: (path) => request(`/files/content?${query({ path })}`),
    },
    git: {
      status: async (cwd) => (await request<{ output: string }>(`/git/status?${query({ cwd })}`)).output,
      diff: async (cwd, file) => (await request<{ output: string }>(`/git/diff?${query({ cwd, file })}`)).output,
      branches: (cwd) => request(`/git/branches?${query({ cwd })}`),
    },
    providers: {
      quotas: (force = false) => request(`/quotas?force=${force}`),
      list: () => request("/providers"),
      login: (providerId, type) => post("/providers/login", { providerId, type }),
      respond: (requestId, value) => post("/providers/respond", { requestId, value }),
      cancel: (requestId) => post("/providers/cancel", { requestId }),
      logout: (providerId) => post("/providers/logout", { providerId }),
      onAuthEvent: (callback) => { authListeners.add(callback); connectEvents("__providers"); return () => authListeners.delete(callback) },
    },
    usage: { snapshot: () => request("/usage") },
    projects: {
      list: () => request("/projects"),
      add: async () => {
        const cwd = window.prompt("Server project path")
        return cwd ? post("/projects", { cwd }) : null
      },
    },
    sessions: {
      list: (cwd) => request(`/sessions?${query({ cwd })}`),
      all: () => request("/sessions/all"),
      import: async (sourcePath, cwd) => (await post<{ path: string }>("/sessions/import", { sourcePath, cwd })).path,
    },
    cwd: async () => (await request<{ cwd: string }>("/cwd")).cwd,
  }
}
