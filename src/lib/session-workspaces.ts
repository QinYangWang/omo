export interface SessionWorkspace {
  cwd: string;
  id: string;
  serverId: string;
  sessionId: string;
  sessionPath?: string;
}

interface SessionWorkspaceSource {
  cwd: string;
  key: string;
  path?: string;
  serverId: string;
}

export const sessionWorkspaceId = (session: SessionWorkspaceSource | null) =>
  session ? `${session.serverId}:${session.key}` : "";

export const rememberSessionWorkspace = (
  contexts: SessionWorkspace[],
  session: SessionWorkspaceSource | null
): SessionWorkspace[] => {
  if (!session) {
    return contexts;
  }
  const context = {
    cwd: session.cwd,
    id: sessionWorkspaceId(session),
    serverId: session.serverId,
    sessionId: session.key,
    sessionPath: session.path,
  };
  const current = contexts.find((item) => item.id === context.id);
  if (
    current?.cwd === context.cwd &&
    current.serverId === context.serverId &&
    current.sessionPath === context.sessionPath
  ) {
    return contexts;
  }
  return current
    ? contexts.map((item) => (item.id === context.id ? context : item))
    : [...contexts, context];
};
