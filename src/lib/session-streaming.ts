import { useEffect, useState } from "react";

// Streaming state per pi session, keyed by `${serverId}:${sessionId}`.
// ChatView writes it as sessions start/stop generating; Sidebar reads it to
// show the in-progress spinner next to running sessions.
const streamingSessions = new Map<string, boolean>();
const listeners = new Set<() => void>();

export function setSessionStreaming(cacheKey: string, value: boolean) {
  if (streamingSessions.get(cacheKey) === value) {
    return;
  }
  streamingSessions.set(cacheKey, value);
  for (const listener of listeners) {
    listener();
  }
}

export function isSessionStreaming(cacheKey: string): boolean {
  return streamingSessions.get(cacheKey) ?? false;
}

/** Snapshot of sessions currently generating, keyed by `${serverId}:${sessionId}`. */
export function useStreamingSessions(): Record<string, boolean> {
  const [table, setTable] = useState<Record<string, boolean>>(() =>
    Object.fromEntries(streamingSessions)
  );
  useEffect(() => {
    const listener = () => setTable(Object.fromEntries(streamingSessions));
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  }, []);
  return table;
}
