export interface SessionWorkspace {
  cwd: string;
  id: string;
  serverId: string;
}

interface SessionWorkspaceSource {
  cwd: string;
  key: string;
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
  };
  const current = contexts.find((item) => item.id === context.id);
  if (current?.cwd === context.cwd && current.serverId === context.serverId) {
    return contexts;
  }
  return current
    ? contexts.map((item) => (item.id === context.id ? context : item))
    : [...contexts, context];
};
