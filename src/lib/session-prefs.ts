import { useSyncExternalStore } from "react";

export interface SessionPref {
  archived?: boolean;
  pinned?: boolean;
  project?: string;
  title?: string;
}

export type SessionPrefs = Record<string, SessionPref>;

const STORAGE_KEY = "omo:sessionPrefs";
const listeners = new Set<() => void>();
let cache: SessionPrefs | null = null;

function load(): SessionPrefs {
  if (!cache) {
    try {
      cache = JSON.parse(
        localStorage.getItem(STORAGE_KEY) ?? "{}"
      ) as SessionPrefs;
    } catch {
      cache = {};
    }
  }
  return cache;
}

export function sessionKey(serverId: string, path: string): string {
  return `${serverId}:${path}`;
}

export function setSessionPref(key: string, patch: Partial<SessionPref>) {
  const next = { ...load() };
  const merged = { ...next[key], ...patch };
  if (merged.pinned || merged.archived) {
    next[key] = merged;
  } else {
    delete next[key];
  }
  cache = next;
  localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  for (const listener of listeners) {
    listener();
  }
}

export function useSessionPrefs(): SessionPrefs {
  return useSyncExternalStore((listener) => {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  }, load);
}
