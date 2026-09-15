import { useEffect, useState } from "react";

// Streaming state per pi session, keyed by `${serverId}:${sessionId}`.
// ChatView writes it as sessions start/stop generating; Sidebar reads it to
// show the in-progress spinner next to running sessions.
const streamingSessions = new Map<string, boolean>();
const streamingAliases = new Map<string, string>();
const listeners = new Set<() => void>();

function notifyListeners(): void {
  for (const listener of listeners) {
    listener();
  }
}

/**
 * Associate persisted session identifiers (the JSONL id/path) with the
 * client-side key used to run the live agent. New sessions use different
 * values for these identifiers, so the sidebar needs these aliases to show
 * every concurrently running session.
 */
export function bindSessionStreamingAliases(
  cacheKey: string,
  aliases: string[]
): void {
  const value = streamingSessions.get(cacheKey) ?? false;
  let changed = false;
  for (const alias of aliases) {
    if (alias === cacheKey) {
      continue;
    }
    if (
      streamingAliases.get(alias) !== cacheKey ||
      streamingSessions.get(alias) !== value
    ) {
      streamingAliases.set(alias, cacheKey);
      streamingSessions.set(alias, value);
      changed = true;
    }
  }
  if (changed) {
    notifyListeners();
  }
}

export function setSessionStreaming(cacheKey: string, value: boolean): void {
  let changed = streamingSessions.get(cacheKey) !== value;
  streamingSessions.set(cacheKey, value);
  for (const [alias, target] of streamingAliases) {
    if (target === cacheKey && streamingSessions.get(alias) !== value) {
      streamingSessions.set(alias, value);
      changed = true;
    }
  }
  if (changed) {
    notifyListeners();
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
