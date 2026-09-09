import {
  Add01Icon,
  AiBrain01Icon,
  ArrowUp02Icon,
  Cancel01Icon,
  FileAttachmentIcon,
  FileIcon,
  Folder01Icon,
  FolderAddIcon,
  GitBranchIcon,
  Image01Icon,
  Loading03Icon,
  MonitorIcon,
  Search01Icon,
  SparklesIcon,
  StopIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import {
  Fragment,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { type ListRange, Virtuoso, type VirtuosoHandle } from "react-virtuoso";
import {
  AiAgentInput,
  AiAgentInputButton,
  AiAgentInputCompletionItem,
  AiAgentInputCompletionMenu,
  AiAgentInputCompletionMeta,
  AiAgentInputFooter,
  AiAgentInputHeader,
  AiAgentInputSelectTrigger,
  AiAgentInputTextarea,
} from "@/components/aicss/AiAgentInput";
import { Outline } from "@/components/chat/outline";
import { ImagePreviews, TurnCard } from "@/components/chat/turn-card";
import { ProviderIcon } from "@/components/provider-icon";
import { Button } from "@/components/ui/button";
import {
  Combobox,
  ComboboxCollection,
  ComboboxEmpty,
  ComboboxGroup,
  ComboboxGroupLabel,
  ComboboxInput,
  ComboboxItem,
  ComboboxList,
  ComboboxPopup,
  ComboboxSeparator,
  ComboboxTrigger,
  ComboboxValue,
} from "@/components/ui/combobox";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectButton,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectSeparator,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import {
  appendMessages,
  type ChatMessage,
  type ConversationTurn,
  type ImageContent,
  prependWindow,
  type TurnWindow,
  toTurns,
  windowFromMessages,
} from "@/lib/conversation-turns";
import { useI18n } from "@/lib/i18n";
import { adaptPiEvent, adaptPiMessages } from "@/lib/pi-adapter";
import { getServerApi } from "@/lib/servers";
import {
  isSessionStreaming,
  setSessionStreaming,
} from "@/lib/session-streaming";
import { cn, randomUUID } from "@/lib/utils";

interface ActiveSession {
  cwd: string;
  key: string;
  path?: string;
  project: string;
  projectId: string;
  serverId: string;
  title: string;
}
interface ImageAttachment extends ImageContent {
  id: string;
  name: string;
}
interface FileAttachment {
  display: string;
  id: string;
  image: boolean;
  name: string;
  path: string;
}
interface FileEntry {
  dir: boolean;
  name: string;
}
interface CompletionItem {
  description?: string;
  directory?: boolean;
  label: string;
  value: string;
}
interface CompletionContext {
  kind: "file" | "command";
  query: string;
  tokenStart: number;
}
interface SlashCommand {
  description?: string;
  name: string;
  source?: string;
}

const EMPTY_PROJECT_LIMIT = 5;
// Thinking levels in ascending effort order; also used to clamp the level
// when switching to a model that supports fewer levels.
const THINKING_LEVELS = [
  { key: "thinking_level_off", value: "off" },
  { key: "thinking_level_minimal", value: "minimal" },
  { key: "thinking_level_low", value: "low" },
  { key: "thinking_level_medium", value: "medium" },
  { key: "thinking_level_high", value: "high" },
  { key: "thinking_level_extra_high", value: "xhigh" },
  { key: "thinking_level_maximum", value: "max" },
] as const;
type ReplaceCompletion = (
  replacement: string,
  nextCursor: number,
  nextCompletion?: CompletionContext | null
) => void;

const MAX_IMAGE_ATTACHMENTS = 8;
const MAX_IMAGE_BYTES = 1_250_000;
const MAX_IMAGE_DATA_LENGTH = 8_000_000;
const imageMimeTypes: Record<string, string> = {
  ".bmp": "image/bmp",
  ".gif": "image/gif",
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".png": "image/png",
  ".webp": "image/webp",
};
const windows = new Map<string, TurnWindow>();
const windowAccess = new Map<string, number>();
const MAX_CACHED_SESSION_WINDOWS = 12;
// Remember the session's model/thinking so returning to a cached window
// restores the same model instead of falling back to the default one.
const sessionMetaCache = new Map<
  string,
  { model?: string; thinking?: string }
>();
// Last known context usage per session; prevents the usage ring from
// flashing empty when switching back to a session.
const contextUsageCache = new Map<string, PiContextUsage | null>();
const sessionListeners = new Map<string, Set<() => void>>();
const fileSyncListeners = new Map<string, Set<() => void>>();
const apiEventSubscriptions = new WeakMap<omoApi, () => void>();
const composerDrafts = new Map<
  string,
  {
    fileAttachments: FileAttachment[];
    images: ImageAttachment[];
    mode: "local" | "worktree";
    text: string;
  }
>();
const COMPOSER_STORAGE_PREFIX = "omo:composer:";

const sessionCacheKey = (serverId: string, sessionId: string) =>
  `${serverId}:${sessionId}`;

function cacheWindow(cacheKey: string, value: TurnWindow) {
  windows.set(cacheKey, value);
  windowAccess.set(cacheKey, Date.now());
  if (windows.size <= MAX_CACHED_SESSION_WINDOWS) {
    return;
  }
  const candidates = [...windowAccess.entries()]
    .filter(
      ([key]) =>
        key !== cacheKey &&
        !isSessionStreaming(key) &&
        !sessionListeners.get(key)?.size
    )
    .sort((left, right) => left[1] - right[1]);
  const oldest = candidates[0]?.[0];
  if (oldest) {
    windows.delete(oldest);
    windowAccess.delete(oldest);
  }
}

function readWindow(cacheKey: string) {
  const value = windows.get(cacheKey);
  if (value) {
    windowAccess.set(cacheKey, Date.now());
  }
  return value;
}

function notifySession(cacheKey: string) {
  for (const listener of sessionListeners.get(cacheKey) ?? []) {
    listener();
  }
}

function ensureApiEventBridge(api: omoApi, serverId: string) {
  if (apiEventSubscriptions.has(api)) {
    return;
  }
  const unsubscribe = api.pi.onEvent(({ sessionId, event }) => {
    const cacheKey = sessionCacheKey(serverId, sessionId);
    if (event.type === "omo_session_file") {
      for (const listener of fileSyncListeners.get(cacheKey) ?? []) {
        listener();
      }
      return;
    }
    handlePiEvent(
      event,
      cacheKey,
      (value) => {
        setSessionStreaming(cacheKey, value);
        notifySession(cacheKey);
      },
      (next) => {
        cacheWindow(cacheKey, next);
        notifySession(cacheKey);
      }
    );
  });
  apiEventSubscriptions.set(api, unsubscribe);
}

function subscribeSession(cacheKey: string, listener: () => void) {
  const listeners = sessionListeners.get(cacheKey) ?? new Set<() => void>();
  listeners.add(listener);
  sessionListeners.set(cacheKey, listeners);
  return () => {
    listeners.delete(listener);
    if (!listeners.size) {
      sessionListeners.delete(cacheKey);
    }
  };
}

function subscribeFileSync(cacheKey: string, listener: () => void) {
  const listeners = fileSyncListeners.get(cacheKey) ?? new Set<() => void>();
  listeners.add(listener);
  fileSyncListeners.set(cacheKey, listeners);
  return () => {
    listeners.delete(listener);
    if (!listeners.size) {
      fileSyncListeners.delete(cacheKey);
    }
  };
}

function cacheComposer(
  cacheKey: string,
  draft: {
    fileAttachments: FileAttachment[];
    images: ImageAttachment[];
    mode: "local" | "worktree";
    text: string;
  }
) {
  composerDrafts.delete(cacheKey);
  composerDrafts.set(cacheKey, draft);
  if (composerDrafts.size <= MAX_CACHED_SESSION_WINDOWS) {
    return;
  }
  const oldest = [...composerDrafts.keys()].find(
    (key) => key !== cacheKey && !isSessionStreaming(key)
  );
  if (oldest) {
    composerDrafts.delete(oldest);
  }
}

function readComposerText(cacheKey: string) {
  try {
    return localStorage.getItem(`${COMPOSER_STORAGE_PREFIX}${cacheKey}`) ?? "";
  } catch {
    return "";
  }
}

const trailingSlashes = /[\\/]+$/;
const leadingSlashes = /^[/\\]+/;
const backslashes = /\\/g;
const commandPattern = /^\/([^\s]*)$/;
const filePattern = /(?:^|\s)@([^\s]*)$/;
const lunaPattern = /luna/i;
const noop = () => undefined;

const joinWorkspacePath = (cwd: string, relative: string) =>
  `${cwd.replace(trailingSlashes, "")}/${relative.replace(leadingSlashes, "")}`;
const fileMimeType = (name: string) =>
  imageMimeTypes[name.slice(name.lastIndexOf(".")).toLowerCase()];

function applyCompletion(
  item: CompletionItem,
  completion: CompletionContext,
  replaceCompletion: ReplaceCompletion,
  session: ActiveSession | null,
  setFileAttachments: React.Dispatch<React.SetStateAction<FileAttachment[]>>
) {
  if (completion.kind === "command") {
    replaceCompletion(
      `/${item.value} `,
      completion.tokenStart + item.value.length + 2,
      null
    );
    return;
  }
  const itemPath = item.value.replace(backslashes, "/");
  const pathWithSlash = item.directory ? `${itemPath}/` : itemPath;
  const token = `@${pathWithSlash.includes(" ") ? `"${pathWithSlash}"` : pathWithSlash}`;
  const replacement = item.directory ? token : `${token} `;
  const nextCursor = completion.tokenStart + replacement.length;
  const nextCompletion = item.directory
    ? {
        kind: "file" as const,
        query: pathWithSlash,
        tokenStart: completion.tokenStart,
      }
    : null;
  replaceCompletion(replacement, nextCursor, nextCompletion);
  if (!session || item.directory) {
    return;
  }
  const path = joinWorkspacePath(session.cwd, itemPath);
  setFileAttachments((current) =>
    current.some((file) => file.path === path)
      ? current
      : [
          ...current,
          {
            display: itemPath,
            id: randomUUID(),
            image: !!fileMimeType(item.label),
            name: item.label,
            path,
          },
        ]
  );
}

function findCompletionContext(
  value: string,
  cursor: number
): CompletionContext | null {
  const before = value.slice(0, cursor);
  const command = before.match(commandPattern);
  if (command) {
    return { kind: "command", query: command[1], tokenStart: 0 };
  }
  const file = before.match(filePattern);
  if (!file) {
    return null;
  }
  const matchStart = file.index ?? 0;
  return {
    kind: "file",
    query: file[1],
    tokenStart: before[matchStart] === "@" ? matchStart : matchStart + 1,
  };
}

function readBlobAsBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const value = typeof reader.result === "string" ? reader.result : "";
      const comma = value.indexOf(",");
      if (comma < 0) {
        reject(new Error("Unable to read image"));
      } else {
        resolve(value.slice(comma + 1));
      }
    };
    reader.onerror = () =>
      reject(reader.error ?? new Error("Unable to read image"));
    reader.readAsDataURL(blob);
  });
}

async function resizeImageIfNeeded(file: File): Promise<Blob> {
  if (file.size <= MAX_IMAGE_BYTES) {
    return file;
  }
  if (typeof createImageBitmap !== "function") {
    throw new Error("Image is too large");
  }
  const bitmap = await createImageBitmap(file);
  try {
    const scale = Math.min(
      1,
      Math.sqrt(MAX_IMAGE_BYTES / file.size),
      1600 / Math.max(bitmap.width, bitmap.height)
    );
    const compress = async (
      currentScale: number,
      attempt: number
    ): Promise<Blob | null> => {
      const canvas = document.createElement("canvas");
      canvas.width = Math.max(1, Math.round(bitmap.width * currentScale));
      canvas.height = Math.max(1, Math.round(bitmap.height * currentScale));
      const context = canvas.getContext("2d");
      if (!context) {
        return null;
      }
      context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
      const resized = await new Promise<Blob | null>((resolve) =>
        canvas.toBlob(resolve, "image/jpeg", 0.82)
      );
      if (resized && resized.size <= MAX_IMAGE_BYTES) {
        return resized;
      }
      if (attempt >= 2) {
        return null;
      }
      return compress(currentScale * 0.7, attempt + 1);
    };
    const resized = await compress(scale, 0);
    if (resized) {
      return resized;
    }
  } finally {
    bitmap.close();
  }
  throw new Error("Image is too large");
}

async function createImageAttachment(file: File): Promise<ImageAttachment> {
  const source = await resizeImageIfNeeded(file);
  return {
    data: await readBlobAsBase64(source),
    id: randomUUID(),
    mimeType: source.type || file.type || "image/png",
    name: file.name || "clipboard-image",
    type: "image",
  };
}

async function preparePrompt(
  api: omoApi,
  value: string,
  images: ImageAttachment[],
  files: FileAttachment[]
) {
  const attachedImages: ImageContent[] = images.map(
    ({ id: _id, ...image }) => image
  );
  // 只有图片附件需要在这里读出内容并作为 image 传给模型；文本文件不内联内容，
  // 会话文本里已有的 `@path` 就是引用地址，由 agent 用自己的文件工具自行读取。
  const imageFiles = files.filter((file) => file.image);
  const results = await Promise.all(
    imageFiles.map(async (file) => ({
      file,
      result: await api.fs.read(file.path, true),
    }))
  );
  for (const { file, result } of results) {
    if (result.error) {
      throw new Error(`${file.name}: ${result.error}`);
    }
    if (result.data && result.mimeType) {
      if (result.data.length > MAX_IMAGE_DATA_LENGTH) {
        throw new Error(`${file.name}: Image is too large`);
      }
      attachedImages.push({
        data: result.data,
        mimeType: result.mimeType,
        name: file.name,
        type: "image",
      });
    }
  }
  return { images: attachedImages, text: value };
}

const completionIcon = (directory?: boolean) =>
  directory ? Folder01Icon : FileIcon;

function CompletionMenu({
  kind,
  items,
  activeIndex,
  loading,
  onSelect,
}: {
  kind: "file" | "command";
  items: CompletionItem[];
  activeIndex: number;
  loading?: boolean;
  onSelect: (item: CompletionItem) => void;
}) {
  const { t } = useI18n();
  if (!(loading || items.length)) {
    return null;
  }
  return (
    <AiAgentInputCompletionMenu
      aria-label={
        kind === "file" ? t("completion_files") : t("completion_commands")
      }
      role="listbox"
    >
      {loading ? (
        <AiAgentInputCompletionMeta className="flex items-center gap-2">
          <HugeiconsIcon
            className="size-3.5 animate-spin"
            icon={Loading03Icon}
          />
          {t("completion_loading")}
        </AiAgentInputCompletionMeta>
      ) : null}
      <TooltipProvider delay={350}>
        {items.map((item, index) => {
          const Icon = kind === "file" ? completionIcon(item.directory) : null;
          const option = (
            <AiAgentInputCompletionItem
              active={index === activeIndex}
              aria-selected={index === activeIndex}
              key={item.value}
              onClick={() => onSelect(item)}
              onMouseDown={(event) => event.preventDefault()}
              role="option"
              title={kind === "file" ? item.label : undefined}
            >
              {Icon ? (
                <HugeiconsIcon data-icon="inline-start" icon={Icon} />
              ) : null}
              <span className="min-w-0 flex-1 truncate">
                {kind === "command" ? `/${item.label}` : item.label}
                {item.directory ? "/" : ""}
              </span>
            </AiAgentInputCompletionItem>
          );
          if (kind !== "command" || !item.description) {
            return option;
          }
          return (
            <Tooltip key={item.value}>
              <TooltipTrigger render={option} />
              <TooltipContent align="start" side="right">
                {item.description}
              </TooltipContent>
            </Tooltip>
          );
        })}
      </TooltipProvider>
      <AiAgentInputCompletionMeta>
        {t("completion_keyboard_hint")}
      </AiAgentInputCompletionMeta>
    </AiAgentInputCompletionMenu>
  );
}

function findTurnIndex(
  turnWindow: TurnWindow,
  turnId: string,
  absoluteIndex?: number
) {
  return turnWindow.turns.findIndex(
    (turn) =>
      turn.id === turnId ||
      (absoluteIndex !== undefined && turn.absoluteIndex === absoluteIndex)
  );
}

function scrollToTurn(
  virtuoso: VirtuosoHandle | null,
  turnWindow: TurnWindow,
  index: number,
  visibleTurn?: ConversationTurn
) {
  const targetTurn = turnWindow.turns[index];
  if (!targetTurn) {
    return false;
  }
  const near =
    visibleTurn !== undefined &&
    Math.abs(targetTurn.absoluteIndex - visibleTurn.absoluteIndex) <= 5;
  // Virtuoso's public API uses absolute coordinates when firstItemIndex is
  // set, so the data-relative index must be offset by the window start.
  virtuoso?.scrollToIndex({
    align: "start",
    behavior: near ? "smooth" : "auto",
    index: turnWindow.start + index,
    offset: -8,
  });
  return true;
}

interface SessionBinding {
  key: string;
  path: string;
  projectId: string;
  title: string;
}

async function sendPrompt(
  api: omoApi,
  key: string,
  session: ActiveSession,
  prepared: { text: string; images: ImageContent[] },
  title: string,
  onSessionBound: (binding: SessionBinding) => void
) {
  const promptImages = prepared.images.map(({ type, data, mimeType }) => ({
    data,
    mimeType,
    type,
  }));
  const result = await api.pi.prompt(
    key,
    prepared.text,
    session.cwd,
    session.path,
    promptImages
  );
  // A draft session gets its JSONL file on the first prompt; bind the
  // path so the sidebar lists it and the header shows its title.
  if (!session.path && result?.sessionFile) {
    onSessionBound({
      key,
      path: result.sessionFile,
      projectId: session.projectId,
      title,
    });
  }
}

export function ChatView({
  session,
  projects,
  onSelectProject,
  onRequestAddProject,
  onClearProject,
  onSessionBound,
}: {
  session: ActiveSession | null;
  projects: Project[];
  onSelectProject: (project: Project) => void;
  onRequestAddProject: () => void;
  onClearProject: () => void;
  onSessionBound: (binding: SessionBinding) => void;
}) {
  const { t } = useI18n();
  const serverId = session?.serverId ?? "local";
  const api = getServerApi(serverId);
  const key = session?.key ?? "draft";
  const cacheKey = sessionCacheKey(serverId, key);
  const sessionCwd = session?.cwd;
  const sessionPath = session?.path;
  const composerDraft = composerDrafts.get(cacheKey);
  const [turnWindow, setTurnWindow] = useState<TurnWindow>(
    () => readWindow(cacheKey) ?? windowFromMessages([], 0, false)
  );
  const [streaming, setStreaming] = useState(() =>
    isSessionStreaming(cacheKey)
  );
  const [loading, setLoading] = useState(false);
  const [mode, setMode] = useState<"local" | "worktree">(
    () => composerDraft?.mode ?? "local"
  );
  const [branches, setBranches] = useState<
    { name: string; current: boolean }[]
  >([]);
  const [models, setModels] = useState<AgentModelInfo[]>([]);
  const [model, setModel] = useState("");
  const [thinking, setThinking] = useState("max");
  const [text, setText] = useState(
    () => composerDraft?.text ?? readComposerText(cacheKey)
  );
  const [images, setImages] = useState<ImageAttachment[]>(
    () => composerDraft?.images ?? []
  );
  const [fileAttachments, setFileAttachments] = useState<FileAttachment[]>(
    () => composerDraft?.fileAttachments ?? []
  );
  const [commands, setCommands] = useState<SlashCommand[]>([]);
  const [contextUsage, setContextUsageState] = useState<PiContextUsage | null>(
    () => contextUsageCache.get(cacheKey) ?? null
  );
  const setContextUsage = useCallback(
    (usage: PiContextUsage | null) => {
      contextUsageCache.set(cacheKey, usage);
      setContextUsageState(usage);
    },
    [cacheKey]
  );
  const [completion, setCompletion] = useState<CompletionContext | null>(null);
  const [suggestionIndex, setSuggestionIndex] = useState(0);
  const [inputError, setInputError] = useState("");
  const textarea = useRef<HTMLTextAreaElement>(null);
  const [visibleRange, setVisibleRange] = useState<ListRange>();
  const [highlightedId, setHighlightedId] = useState<string>();
  const virtuoso = useRef<VirtuosoHandle>(null);
  const loadingOlder = useRef<{
    key: string;
    promise: Promise<TurnWindow | undefined>;
  } | null>(null);
  const jumping = useRef<Set<string>>(new Set());
  const jumpToken = useRef(0);
  const keyRef = useRef(key);
  keyRef.current = key;
  const cacheKeyRef = useRef(cacheKey);
  cacheKeyRef.current = cacheKey;
  const sessionPathRef = useRef(sessionPath);
  sessionPathRef.current = sessionPath;
  const streamingRef = useRef<boolean>(false);
  const syncTimer = useRef<ReturnType<typeof setTimeout> | undefined>(
    undefined
  );

  const visibleTurn = visibleRange
    ? turnWindow.turns[
        Math.min(
          Math.max(0, visibleRange.startIndex - turnWindow.start),
          Math.max(0, turnWindow.turns.length - 1)
        )
      ]
    : undefined;

  const setWindow = useCallback(
    (next: TurnWindow) => {
      cacheWindow(cacheKey, next);
      setTurnWindow(next);
      notifySession(cacheKey);
    },
    [cacheKey]
  );

  const loadHistoryPage = (): Promise<TurnWindow | undefined> => {
    const targetKey = keyRef.current;
    const targetCacheKey = cacheKeyRef.current;
    const inFlight = loadingOlder.current;
    if (inFlight?.key === targetKey) {
      return inFlight.promise;
    }
    const current = windows.get(targetCacheKey) ?? turnWindow;
    if (!(session && current.hasOlder)) {
      return Promise.resolve(undefined);
    }
    const promise = (async () => {
      try {
        const result = await api.pi.history(targetKey, current.startCursor);
        if (keyRef.current !== targetKey) {
          return;
        }
        const latest = windows.get(targetCacheKey) ?? current;
        if (result.cursor >= latest.start && !result.messages.length) {
          return;
        }
        const next = prependWindow(
          latest,
          result.messages as ChatMessage[],
          result.cursor,
          result.hasMore
        );
        setWindow(next);
        return next;
      } catch {
        // History loading is best effort; Virtuoso can retry at the boundary.
      }
    })();
    const tracked = promise.finally(() => {
      if (loadingOlder.current?.promise === tracked) {
        loadingOlder.current = null;
      }
    });
    loadingOlder.current = { key: targetKey, promise: tracked };
    return tracked;
  };

  const loadOlder = (): Promise<TurnWindow | undefined> => {
    if (jumping.current.has(keyRef.current)) {
      return Promise.resolve(undefined);
    }
    return loadHistoryPage();
  };

  const jumpTo = async (turnId: string) => {
    const token = jumpToken.current + 1;
    const targetKey = keyRef.current;
    jumpToken.current = token;
    jumping.current.add(targetKey);
    try {
      let current = windows.get(cacheKeyRef.current) ?? turnWindow;
      const target = current.metas.find((meta) => meta.id === turnId);
      let index = findTurnIndex(current, turnId, target?.absoluteIndex);
      let loadedOlder = false;
      if (
        index < 0 &&
        target !== undefined &&
        target.absoluteIndex < current.start
      ) {
        const loaded = await loadUntilTurn(
          current,
          target.absoluteIndex,
          loadHistoryPage
        );
        if (!loaded || token !== jumpToken.current) {
          return;
        }
        current = loaded;
        loadedOlder = true;
        index = findTurnIndex(current, turnId, target.absoluteIndex);
      }
      if (index < 0 || token !== jumpToken.current) {
        return;
      }
      if (loadedOlder) {
        // Give Virtuoso two frames to ingest the prepended turns and
        // re-measure before scrolling, otherwise the offset estimate is
        // based on stale heights.
        await new Promise<void>((resolve) => {
          window.requestAnimationFrame(() => {
            window.requestAnimationFrame(() => resolve());
          });
        });
      }
      if (token !== jumpToken.current) {
        return;
      }
      // Immediate feedback: highlight the target and activate the outline
      // tick before the scroll settles.
      setHighlightedId(turnId);
      window.setTimeout(
        () => setHighlightedId((id) => (id === turnId ? undefined : id)),
        1600
      );
      scrollToTurn(virtuoso.current, current, index, visibleTurn);
    } finally {
      window.setTimeout(() => {
        if (jumpToken.current === token) {
          jumping.current.delete(targetKey);
        }
      }, 700);
    }
  };

  useEffect(() => {
    if (!session) {
      return;
    }
    api.pi.retain(key).catch(() => undefined);
    return () => {
      api.pi.release(key).catch(() => undefined);
    };
  }, [api, key, session]);

  useEffect(() => {
    ensureApiEventBridge(api, serverId);
    return subscribeSession(cacheKey, () => {
      const nextWindow = windows.get(cacheKey);
      if (nextWindow) {
        setTurnWindow(nextWindow);
      }
      setStreaming(isSessionStreaming(cacheKey));
    });
  }, [api, cacheKey, serverId]);

  useEffect(() => {
    cacheComposer(cacheKey, { fileAttachments, images, mode, text });
    try {
      if (text) {
        localStorage.setItem(`${COMPOSER_STORAGE_PREFIX}${cacheKey}`, text);
      } else {
        localStorage.removeItem(`${COMPOSER_STORAGE_PREFIX}${cacheKey}`);
      }
    } catch {
      // Draft persistence is best effort (private mode and quotas may reject it).
    }
  }, [cacheKey, fileAttachments, images, mode, text]);

  useEffect(() => {
    loadSession(
      api,
      key,
      cacheKey,
      sessionCwd,
      sessionPath,
      setTurnWindow,
      setWindow,
      setLoading,
      setModel,
      setThinking
    );
  }, [api, cacheKey, key, sessionCwd, sessionPath, setWindow]);

  useEffect(() => {
    api.models
      .list()
      .then((available) => {
        const enabled = available.filter((item) => item.enabled);
        setModels(enabled);
        const preferred =
          enabled.find((item) => lunaPattern.test(item.name)) ?? enabled[0];
        if (preferred) {
          setModel(
            (current) => current || `${preferred.provider}/${preferred.id}`
          );
        }
      })
      .catch(() => undefined);
  }, [api]);

  const reloadBranches = useCallback(async () => {
    if (!sessionCwd) {
      return;
    }
    setBranches(await api.git.branches(sessionCwd));
  }, [api, sessionCwd]);

  useEffect(() => {
    if (!sessionCwd) {
      return setBranches([]);
    }
    reloadBranches();
  }, [reloadBranches, sessionCwd]);

  useEffect(() => {
    let active = true;
    setCommands([]);
    if (!sessionCwd) {
      return;
    }
    api.pi
      .commands(key, sessionCwd, sessionPath)
      .then((available) => {
        if (active) {
          setCommands(available);
        }
      })
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, [api, key, sessionCwd, sessionPath]);

  const { fileEntries, fileLoading, fileQuery } = useFileCompletion(
    api,
    sessionCwd,
    completion
  );
  const fileNameQuery = fileQuery
    .slice(fileQuery.lastIndexOf("/") + 1)
    .toLowerCase();
  const fileDirectory = fileQuery.slice(0, fileQuery.lastIndexOf("/") + 1);
  const fileSuggestions: CompletionItem[] = fileEntries
    .filter((entry) => entry.name.toLowerCase().includes(fileNameQuery))
    .map((entry) => ({
      description: entry.dir ? "Folder01Icon" : undefined,
      directory: entry.dir,
      label: entry.name,
      value: `${fileDirectory}${entry.name}`,
    }))
    .slice(0, 20);
  const commandSuggestions: CompletionItem[] = commands
    .filter((command) =>
      command.name.toLowerCase().includes(completion?.query.toLowerCase() ?? "")
    )
    .map((command) => ({
      description: command.description || command.source,
      label: command.name,
      value: command.name,
    }))
    .slice(0, 20);
  const completionItems =
    completion?.kind === "file" ? fileSuggestions : commandSuggestions;
  const activeSuggestionIndex = Math.min(
    suggestionIndex,
    Math.max(completionItems.length - 1, 0)
  );

  useEffect(() => {
    let active = true;
    if (!sessionCwd) {
      setContextUsage(null);
      return;
    }
    api.pi
      .contextUsage(key, sessionCwd, sessionPath)
      .then((usage) => {
        if (active) {
          setContextUsage(usage);
        }
      })
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, [api, key, sessionCwd, sessionPath, setContextUsage]);

  // Refresh the ring after every completed turn (agent_end).
  const completionStreamingRef = useRef(streaming);
  useEffect(() => {
    if (completionStreamingRef.current && !streaming && sessionCwd) {
      api.pi
        .contextUsage(key, sessionCwd, sessionPath)
        .then(setContextUsage)
        .catch(() => undefined);
    }
    completionStreamingRef.current = streaming;
  }, [api, key, sessionCwd, sessionPath, streaming, setContextUsage]);

  useEffect(() => {
    streamingRef.current = streaming;
    setSessionStreaming(cacheKey, streaming);
  }, [cacheKey, streaming]);

  // Merge file-based sync (TUI or external writes) into the window.
  const syncFromFile = useCallback(async () => {
    const targetKey = keyRef.current;
    const targetCacheKey = cacheKeyRef.current;
    const path = sessionPathRef.current;
    if (!path || streamingRef.current) {
      return;
    }
    const current = windows.get(targetCacheKey) ?? turnWindow;
    const turnCount = current.start + current.turns.length;
    const tailItemCount = current.turns.at(-1)?.items.length ?? 0;
    try {
      const result = await api.pi.sync(
        targetKey,
        path,
        turnCount,
        tailItemCount
      );
      if (keyRef.current !== targetKey) {
        return;
      }
      const latest = windows.get(targetCacheKey) ?? current;
      setWindow(mergeSyncResult(latest, result));
    } catch {
      // Sync is best effort; the next file change retries.
    }
  }, [api, setWindow, turnWindow]);

  useEffect(
    () =>
      subscribeFileSync(cacheKey, () => {
        // Session JSONL changed on disk (e.g. the same session is active in
        // the pi TUI). Debounce and re-read the tail from disk.
        // biome-ignore lint/suspicious/noUnnecessaryConditions: the ref is updated by the streaming subscription.
        if (streamingRef.current) {
          return;
        }
        clearTimeout(syncTimer.current);
        syncTimer.current = setTimeout(() => {
          syncFromFile().catch(() => undefined);
        }, 300);
      }),
    [cacheKey, syncFromFile]
  );

  const replaceCompletion = (
    replacement: string,
    nextCursor: number,
    nextCompletion?: CompletionContext | null
  ) => {
    const cursor = textarea.current?.selectionStart ?? text.length;
    const start = completion?.tokenStart ?? cursor;
    const next = `${text.slice(0, start)}${replacement}${text.slice(cursor)}`;
    setText(next);
    setCompletion(nextCompletion ?? findCompletionContext(next, nextCursor));
    window.requestAnimationFrame(() => {
      textarea.current?.focus();
      textarea.current?.setSelectionRange(nextCursor, nextCursor);
    });
  };

  const selectCompletion = (item: CompletionItem) => {
    if (completion) {
      applyCompletion(
        item,
        completion,
        replaceCompletion,
        session,
        setFileAttachments
      );
    }
  };

  const addImageFiles = async (files: File[]) => {
    if (!files.length) {
      return;
    }
    if (images.length + files.length > MAX_IMAGE_ATTACHMENTS) {
      setInputError("Too many image attachments");
      return;
    }
    setInputError("");
    try {
      const attachments = await Promise.all(files.map(createImageAttachment));
      setImages((current) => [...current, ...attachments]);
    } catch (error) {
      setInputError(error instanceof Error ? error.message : String(error));
    }
  };

  const handlePaste = async (
    event: React.ClipboardEvent<HTMLTextAreaElement>
  ) => {
    const item = Array.from(event.clipboardData.items).find(
      (entry) => entry.kind === "file" && entry.type.startsWith("image/")
    );
    const file = item?.getAsFile();
    if (!file) {
      return;
    }
    event.preventDefault();
    await addImageFiles([file]);
  };

  const removeImage = (id: string) =>
    setImages((current) => current.filter((image) => image.id !== id));
  const removeFile = (file: FileAttachment) => {
    const token = file.display.includes(" ")
      ? `@"${file.display}"`
      : `@${file.display}`;
    setText((current) => current.replace(token, ""));
    setFileAttachments((current) =>
      current.filter((entry) => entry.id !== file.id)
    );
  };

  const submit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const value = text.trim();
    const activeFiles = fileAttachments.filter((file) => {
      const token = file.display.includes(" ")
        ? `@"${file.display}"`
        : `@${file.display}`;
      return text.includes(token);
    });
    if (!(value || images.length || activeFiles.length)) {
      return;
    }
    setInputError("");
    let prepared: { text: string; images: ImageContent[] };
    try {
      prepared = await preparePrompt(api, value, images, activeFiles);
    } catch (error) {
      setInputError(error instanceof Error ? error.message : String(error));
      return;
    }
    const current = windows.get(cacheKey) ?? turnWindow;
    const next = appendMessages(current, [
      {
        id: randomUUID(),
        images: prepared.images.length ? prepared.images : undefined,
        role: "user",
        text: value,
        timestamp: Date.now(),
      },
    ]);
    setWindow(next);
    setText("");
    setImages([]);
    setFileAttachments([]);
    setCompletion(null);
    setStreaming(true);
    if (session) {
      try {
        await sendPrompt(api, key, session, prepared, value, onSessionBound);
      } catch (error) {
        setInputError(error instanceof Error ? error.message : String(error));
      }
    }
  };

  const input = (
    <PromptInput
      activeSuggestionIndex={activeSuggestionIndex}
      branches={branches}
      completion={completion}
      completionItems={completionItems}
      contextUsage={contextUsage}
      fileAttachments={fileAttachments}
      fileLoading={fileLoading}
      handlePaste={handlePaste}
      images={images}
      inputError={inputError}
      inputRef={textarea}
      mode={mode}
      model={model}
      models={models}
      onAbort={async () => {
        try {
          await api.pi.abort(key);
        } finally {
          setStreaming(false);
        }
      }}
      onAddProject={onRequestAddProject}
      onAttachImages={addImageFiles}
      onBranchesReload={reloadBranches}
      onChangeMode={(value) => setMode(value as "local" | "worktree")}
      onChangeModel={(value) => {
        setModel(value);
        sessionMetaCache.set(cacheKey, {
          ...sessionMetaCache.get(cacheKey),
          model: value,
        });
        const selected = models.find(
          (item) => `${item.provider}/${item.id}` === value
        );
        if (session && selected) {
          api.pi.setModel(key, selected.provider, selected.id);
        }
        // Clamp the thinking level to the new model's supported levels,
        // otherwise the selector loses its selection until re-picked.
        const levels = selected?.thinkingLevels;
        if (levels?.length && !levels.includes(thinking)) {
          const fallback = THINKING_LEVELS.filter((level) =>
            levels.includes(level.value)
          ).at(-1)?.value;
          if (fallback) {
            setThinking(fallback);
            if (session) {
              api.pi.setThinking(key, fallback);
            }
          }
        }
      }}
      onChangeThinking={(value) => {
        setThinking(value);
        sessionMetaCache.set(cacheKey, {
          ...sessionMetaCache.get(cacheKey),
          thinking: value,
        });
        if (session) {
          api.pi.setThinking(key, value);
        }
      }}
      onClearProject={onClearProject}
      onFileRemove={removeFile}
      onImageRemove={removeImage}
      onSelectCompletion={selectCompletion}
      onSelectProject={onSelectProject}
      onSetCompletion={setCompletion}
      onSubmit={submit}
      onSuggestionIndexChange={setSuggestionIndex}
      onTextChange={(value, cursor) => {
        setText(value);
        setCompletion(findCompletionContext(value, cursor));
      }}
      projects={projects}
      session={session}
      streaming={streaming}
      text={text}
      thinking={thinking}
    />
  );

  if (loading) {
    return (
      <div className="flex h-full items-center justify-center text-muted-foreground">
        <HugeiconsIcon className="size-5 animate-spin" icon={Loading03Icon} />
      </div>
    );
  }

  if (turnWindow.turns.length === 0) {
    if (!session) {
      return (
        <NewTaskEmpty
          onAddProject={onRequestAddProject}
          onSelectProject={onSelectProject}
          projects={projects}
        />
      );
    }
    return (
      <div className="flex h-full flex-col justify-center overflow-y-auto px-4 pb-10">
        <Empty className="flex-none gap-6 px-0 pt-8 pb-7">
          <EmptyHeader className="max-w-lg gap-3">
            <EmptyMedia className="mb-3 size-10 rounded-lg border border-border/60 bg-muted/50">
              <HugeiconsIcon
                className="size-5"
                icon={SparklesIcon}
                strokeWidth={1.6}
              />
            </EmptyMedia>
            <EmptyTitle className="text-2xl tracking-tight">
              {t("task_welcome")}
            </EmptyTitle>
            <EmptyDescription>
              {t("working_in_project", { name: session.project })}
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
        <div className="mx-auto w-full max-w-3xl">{input}</div>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col">
      <div className="relative flex min-h-0 flex-1">
        <Virtuoso
          className="h-full w-full"
          data={turnWindow.turns}
          defaultItemHeight={160}
          firstItemIndex={turnWindow.start}
          followOutput={(atBottom) =>
            atBottom && !jumping.current.has(keyRef.current) ? "smooth" : false
          }
          increaseViewportBy={{ bottom: 400, top: 0 }}
          itemContent={(index, turn) => (
            <TurnCard
              highlighted={turn.id === highlightedId}
              onBranch={async (entryId) => {
                setInputError("");
                try {
                  const result = await api.pi.branch(key, entryId);
                  if (result.cancelled) {
                    return;
                  }
                  const next = windowFromMessages(
                    (result.messages ?? []) as ChatMessage[],
                    result.cursor ?? 0,
                    result.hasMore ?? false,
                    result.outline
                  );
                  setWindow(next);
                  setText(result.editorText ?? "");
                  requestAnimationFrame(() => textarea.current?.focus());
                } catch (error) {
                  setInputError(
                    error instanceof Error ? error.message : String(error)
                  );
                }
              }}
              streaming={
                streaming &&
                index - turnWindow.start === turnWindow.turns.length - 1
              }
              turn={turn}
            />
          )}
          rangeChanged={setVisibleRange}
          ref={virtuoso}
          startReached={loadOlder}
        />
        <Outline
          activeId={highlightedId ?? visibleTurn?.id}
          metas={turnWindow.metas}
          onJump={jumpTo}
        />
      </div>
      <div className="mx-auto w-full max-w-3xl px-4 pt-2 pb-3">{input}</div>
    </div>
  );
}

function NewTaskEmpty({
  onAddProject,
  onSelectProject,
  projects,
}: {
  onAddProject: () => void;
  onSelectProject: (project: Project) => void;
  projects: Project[];
}) {
  const { t } = useI18n();
  const visibleProjects = projects.slice(0, EMPTY_PROJECT_LIMIT);

  return (
    <Empty className="h-full gap-5 overflow-y-auto rounded-none px-4 pt-8 pb-10">
      <EmptyHeader className="max-w-lg gap-3">
        <EmptyMedia className="mb-2 size-10 rounded-lg border border-border/60 bg-muted/50">
          <HugeiconsIcon
            className="size-5"
            icon={SparklesIcon}
            strokeWidth={1.6}
          />
        </EmptyMedia>
        <EmptyTitle className="text-2xl tracking-tight">
          {t("task_welcome")}
        </EmptyTitle>
        <EmptyDescription>{t("choose_project_desc")}</EmptyDescription>
      </EmptyHeader>
      <EmptyContent className="w-full gap-1.5">
        <p className="w-full px-1 pb-1 text-left text-muted-foreground text-xs">
          {t("choose_project_start")}
        </p>
        {visibleProjects.map((project) => (
          <Button
            className="group h-auto w-full justify-start rounded-md px-3 py-2 text-left hover:bg-accent"
            key={project.id}
            onClick={() => onSelectProject(project)}
            variant="ghost"
          >
            <span className="flex min-w-0 items-center gap-2.5">
              <HugeiconsIcon data-icon="inline-start" icon={Folder01Icon} />
              <span className="min-w-0">
                <span className="block truncate font-medium text-sm">
                  {project.name}
                </span>
                <span className="block truncate text-muted-foreground text-xs">
                  {project.cwd}
                </span>
              </span>
            </span>
          </Button>
        ))}
        <Button
          className={cn(
            "mt-1 h-9 w-full rounded-md",
            projects.length > 0 && "text-muted-foreground"
          )}
          onClick={onAddProject}
          variant={projects.length ? "ghost" : "default"}
        >
          <HugeiconsIcon data-icon="inline-start" icon={FolderAddIcon} />
          {t("add_project")}
        </Button>
      </EmptyContent>
    </Empty>
  );
}

interface PromptInputProps {
  activeSuggestionIndex: number;
  branches: { current: boolean; name: string }[];
  completion: CompletionContext | null;
  completionItems: CompletionItem[];
  contextUsage: PiContextUsage | null;
  fileAttachments: FileAttachment[];
  fileLoading: boolean;
  handlePaste: (
    event: React.ClipboardEvent<HTMLTextAreaElement>
  ) => Promise<void>;
  images: ImageAttachment[];
  inputError: string;
  inputRef: React.RefObject<HTMLTextAreaElement | null>;
  mode: "local" | "worktree";
  model: string;
  models: AgentModelInfo[];
  onAbort: () => Promise<void>;
  onAddProject: () => void;
  onAttachImages: (files: File[]) => Promise<void>;
  onBranchesReload: () => void;
  onChangeMode: (value: string) => void;
  onChangeModel: (value: string) => void;
  onChangeThinking: (value: string) => void;
  onClearProject: () => void;
  onFileRemove: (file: FileAttachment) => void;
  onImageRemove: (id: string) => void;
  onSelectCompletion: (item: CompletionItem) => void;
  onSelectProject: (project: Project) => void;
  onSetCompletion: (value: CompletionContext | null) => void;
  onSubmit: (event: React.FormEvent<HTMLFormElement>) => Promise<void>;
  onSuggestionIndexChange: React.Dispatch<React.SetStateAction<number>>;
  onTextChange: (value: string, cursor: number) => void;
  projects: Project[];
  session: ActiveSession | null;
  streaming: boolean;
  text: string;
  thinking: string;
}

function PromptInput({
  activeSuggestionIndex,
  branches,
  completion,
  completionItems,
  contextUsage,
  fileAttachments,
  fileLoading,
  handlePaste,
  images,
  inputRef,
  inputError,
  mode,
  model,
  models,
  onAbort,
  onAddProject,
  onAttachImages,
  onChangeMode,
  onChangeModel,
  onChangeThinking,
  onBranchesReload,
  onClearProject,
  onFileRemove,
  onImageRemove,
  onSelectCompletion,
  onSelectProject,
  onSetCompletion,
  onSubmit,
  onSuggestionIndexChange,
  onTextChange,
  projects,
  session,
  streaming,
  text,
  thinking,
}: PromptInputProps) {
  const { t } = useI18n();
  const imageInput = useRef<HTMLInputElement>(null);
  const [branchDialog, setBranchDialog] = useState(false);
  const [branchName, setBranchName] = useState("");
  const [branchError, setBranchError] = useState("");
  const selectedModel = models.find(
    (item) => `${item.provider}/${item.id}` === model
  );
  const thinkingItems = THINKING_LEVELS.map((level) => ({
    label: t(level.key),
    value: level.value,
  })).filter(
    (item) =>
      !selectedModel?.thinkingLevels ||
      selectedModel.thinkingLevels.includes(item.value)
  );
  const createBranch = async () => {
    const name = branchName.trim();
    if (!(session && name)) {
      return;
    }
    const result = await getServerApi(session.serverId).git.createBranch(
      session.cwd,
      name
    );
    if (!result.ok) {
      setBranchError(result.output.trim());
      return;
    }
    setBranchDialog(false);
    setBranchName("");
    setBranchError("");
    onBranchesReload();
  };
  const canSubmit = Boolean(
    streaming || text.trim() || images.length || fileAttachments.length
  );
  const openWorkspaceFile = () => {
    const cursor = inputRef.current?.selectionStart ?? text.length;
    const before = text.slice(0, cursor);
    const insertion =
      before && !before.endsWith(" ") && !before.endsWith("\n") ? " @" : "@";
    const nextCursor = cursor + insertion.length;
    const next = `${before}${insertion}${text.slice(cursor)}`;
    onTextChange(next, nextCursor);
    window.requestAnimationFrame(() => {
      inputRef.current?.focus();
      inputRef.current?.setSelectionRange(nextCursor, nextCursor);
    });
  };
  return (
    <div>
      <div className="mb-2 flex min-h-7 flex-wrap items-center gap-1.5 px-1 text-muted-foreground text-xs">
        <ProjectSelect
          onAdd={onAddProject}
          onClear={onClearProject}
          onSelect={onSelectProject}
          projects={projects}
          value={session?.projectId ?? ""}
        />
        <CompactSelect
          icon={<HugeiconsIcon className="size-3.5" icon={MonitorIcon} />}
          items={[
            {
              icon: <HugeiconsIcon className="size-3.5" icon={MonitorIcon} />,
              label: t("local"),
              value: "local",
            },
            {
              icon: <HugeiconsIcon className="size-3.5" icon={GitBranchIcon} />,
              label: t("worktree"),
              value: "worktree",
            },
          ]}
          onChange={onChangeMode}
          value={mode}
        />
        <CompactSelect
          addLabel={t("new_branch")}
          disabled={!branches.length}
          icon={<HugeiconsIcon className="size-3.5" icon={GitBranchIcon} />}
          items={branches.map((branch) => ({
            icon: <HugeiconsIcon className="size-3.5" icon={GitBranchIcon} />,
            label: branch.name,
            value: branch.name,
          }))}
          onAdd={() => setBranchDialog(true)}
          onChange={noop}
          placeholder={t("no_branch")}
          value={branches.find((branch) => branch.current)?.name ?? ""}
        />
      </div>
      <div className="relative">
        {completion ? (
          <CompletionMenu
            activeIndex={activeSuggestionIndex}
            items={completionItems}
            kind={completion.kind}
            loading={completion.kind === "file" ? fileLoading : false}
            onSelect={onSelectCompletion}
          />
        ) : null}
        <AiAgentInput onSubmit={onSubmit}>
          <AiAgentInputTextarea
            aria-invalid={inputError ? true : undefined}
            aria-label={t("prompt_input")}
            onChange={(event) =>
              onTextChange(event.target.value, event.target.selectionStart)
            }
            onKeyDown={(event) => {
              if (completion && completionItems.length > 0) {
                if (event.key === "ArrowDown" || event.key === "ArrowUp") {
                  event.preventDefault();
                  onSuggestionIndexChange(
                    (current) =>
                      (current +
                        (event.key === "ArrowDown" ? 1 : -1) +
                        completionItems.length) %
                      completionItems.length
                  );
                  return;
                }
                if (event.key === "Enter" || event.key === "Tab") {
                  event.preventDefault();
                  onSelectCompletion(
                    completionItems[activeSuggestionIndex] ?? completionItems[0]
                  );
                  return;
                }
                if (event.key === "Escape") {
                  event.preventDefault();
                  onSetCompletion(null);
                  return;
                }
              }
              if (
                event.key === "Enter" &&
                !event.shiftKey &&
                !event.nativeEvent.isComposing
              ) {
                event.preventDefault();
                event.currentTarget.form?.requestSubmit();
              }
            }}
            onPaste={handlePaste}
            placeholder={t("prompt_placeholder")}
            ref={inputRef}
            value={text}
          />
          {images.length > 0 || fileAttachments.length > 0 ? (
            <AiAgentInputHeader>
              <div className="flex flex-wrap gap-2">
                <ImagePreviews
                  compact
                  images={images}
                  onRemove={onImageRemove}
                />
                {fileAttachments.map((file) => (
                  <Button
                    className="group h-7 max-w-full rounded-full px-2 text-xs"
                    key={file.id}
                    onClick={() => onFileRemove(file)}
                    title={file.path}
                    variant="outline"
                  >
                    <HugeiconsIcon data-icon="inline-start" icon={FileIcon} />
                    <span className="truncate">@{file.display}</span>
                    <HugeiconsIcon data-icon="inline-end" icon={Cancel01Icon} />
                  </Button>
                ))}
              </div>
            </AiAgentInputHeader>
          ) : null}
          <AiAgentInputFooter>
            <div className="flex min-w-0 items-center gap-1">
              <Input
                accept="image/*"
                hidden
                multiple
                onChange={async (event) => {
                  const files = Array.from(event.target.files ?? []);
                  event.target.value = "";
                  await onAttachImages(files);
                }}
                ref={imageInput}
                tabIndex={-1}
                type="file"
              />
              <DropdownMenu>
                <DropdownMenuTrigger
                  render={
                    <AiAgentInputButton
                      aria-label={t("add_attachment")}
                      title={t("add_attachment")}
                      type="button"
                    />
                  }
                >
                  <HugeiconsIcon data-icon="inline-start" icon={Add01Icon} />
                </DropdownMenuTrigger>
                <DropdownMenuContent
                  align="start"
                  className="w-44 p-1 text-xs"
                  side="top"
                >
                  <DropdownMenuGroup>
                    <DropdownMenuItem
                      onClick={() => imageInput.current?.click()}
                    >
                      <HugeiconsIcon icon={Image01Icon} />
                      {t("attach_images")}
                    </DropdownMenuItem>
                    <DropdownMenuItem onClick={openWorkspaceFile}>
                      <HugeiconsIcon icon={FileAttachmentIcon} />
                      {t("attach_workspace_file")}
                    </DropdownMenuItem>
                  </DropdownMenuGroup>
                </DropdownMenuContent>
              </DropdownMenu>
              <ModelSelect
                models={models}
                onChange={onChangeModel}
                placeholder={t("select_model")}
                value={model}
              />
              <CompactSelect
                appearance="composer"
                contentLabel={t("reasoning")}
                icon={<HugeiconsIcon icon={AiBrain01Icon} />}
                items={thinkingItems}
                onChange={onChangeThinking}
                value={thinking}
              />
              <ContextUsageRing
                contextWindow={selectedModel?.contextWindow}
                usage={contextUsage}
              />
            </div>
            <AiAgentInputButton
              active={canSubmit}
              aria-label={streaming ? t("stop_generating") : t("send_message")}
              disabled={!canSubmit}
              onClick={streaming ? onAbort : undefined}
              title={streaming ? t("stop_generating") : t("send_message")}
              type={streaming ? "button" : "submit"}
            >
              {streaming ? (
                <HugeiconsIcon data-icon="inline-start" icon={StopIcon} />
              ) : (
                <HugeiconsIcon data-icon="inline-start" icon={ArrowUp02Icon} />
              )}
            </AiAgentInputButton>
          </AiAgentInputFooter>
        </AiAgentInput>
        {inputError ? (
          <p className="mt-2 px-3 text-destructive text-xs" role="alert">
            {inputError}
          </p>
        ) : null}
      </div>
      <Dialog onOpenChange={setBranchDialog} open={branchDialog}>
        <DialogContent className="sm:max-w-xs">
          <DialogHeader>
            <DialogTitle>{t("new_branch")}</DialogTitle>
          </DialogHeader>
          <form
            onSubmit={(event) => {
              event.preventDefault();
              createBranch();
            }}
          >
            <Input
              aria-label={t("branch_name")}
              autoFocus
              onChange={(event) => setBranchName(event.target.value)}
              placeholder={t("branch_name")}
              value={branchName}
            />
            {branchError ? (
              <p className="mt-2 text-destructive text-xs" role="alert">
                {branchError}
              </p>
            ) : null}
            <DialogFooter className="mt-4">
              <Button disabled={!branchName.trim()} size="sm" type="submit">
                {t("create")}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function cloneTurnWindow(current: TurnWindow): TurnWindow {
  return {
    ...current,
    turns: current.turns.map((turn) => ({
      ...turn,
      items: [...turn.items],
    })),
  };
}

function completeLastAssistant(
  current: TurnWindow,
  setWindow: (next: TurnWindow) => void
) {
  const next = cloneTurnWindow(current);
  const last = next.turns.at(-1);
  if (!last) {
    return;
  }
  let lastAssistantIndex = -1;
  for (let index = last.items.length - 1; index >= 0; index -= 1) {
    if (last.items[index].role === "assistant") {
      lastAssistantIndex = index;
      break;
    }
  }
  if (lastAssistantIndex < 0) {
    return;
  }
  const completedAt = Date.now();
  last.items = last.items.map((item, index) => {
    if (index !== lastAssistantIndex || item.role !== "assistant") {
      return item;
    }
    return {
      ...item,
      completedAt,
      durationMs: last.user.timestamp
        ? completedAt - last.user.timestamp
        : undefined,
      turnEnd: true,
    };
  });
  setWindow(next);
}

async function loadSession(
  api: omoApi,
  key: string,
  cacheKey: string,
  sessionCwd: string | undefined,
  sessionPath: string | undefined,
  setTurnWindow: (next: TurnWindow) => void,
  setWindow: (next: TurnWindow) => void,
  setLoading: (value: boolean) => void,
  setModel: (value: string) => void,
  setThinking: (value: string) => void
) {
  const cached = readWindow(cacheKey);
  setTurnWindow(cached ?? windowFromMessages([], 0, false));
  const remembered = sessionMetaCache.get(cacheKey);
  if (cached) {
    // Cached windows skip pi.open, so restore the model/thinking we
    // remembered when the session was last opened or changed.
    if (remembered?.model) {
      setModel(remembered.model);
    }
    if (remembered?.thinking) {
      setThinking(remembered.thinking);
    }
    setLoading(false);
    return;
  }
  if (sessionCwd === undefined) {
    setLoading(false);
    return;
  }
  setLoading(true);
  try {
    const {
      messages: history,
      cursor,
      hasMore,
      outline,
      model: sessionModel,
      thinkingLevel,
      isStreaming,
    } = await api.pi.open(key, sessionCwd, sessionPath);
    setWindow(
      windowFromMessages(history as ChatMessage[], cursor, hasMore, outline)
    );
    if (sessionModel) {
      const value = `${sessionModel.provider}/${sessionModel.id}`;
      setModel(value);
      sessionMetaCache.set(cacheKey, {
        ...sessionMetaCache.get(cacheKey),
        model: value,
      });
    }
    if (thinkingLevel) {
      setThinking(thinkingLevel);
      sessionMetaCache.set(cacheKey, {
        ...sessionMetaCache.get(cacheKey),
        thinking: thinkingLevel,
      });
    }
    setSessionStreaming(cacheKey, isStreaming ?? false);
    notifySession(cacheKey);
    setLoading(false);
  } catch (error) {
    const failed: ChatMessage[] = [
      {
        id: randomUUID(),
        role: "assistant",
        text: `Failed to open session: ${error instanceof Error ? error.message : String(error)}`,
      },
    ];
    setWindow(windowFromMessages(failed, 0, false));
    setLoading(false);
  }
}

interface PiSyncResult {
  fromTurn: number;
  messages: unknown[];
  metas: { absoluteIndex: number; id: string; userPreview: string }[];
  totalTurns: number;
}

/** Merge a file-sync tail into the window; refresh the outline regardless. */
function mergeSyncResult(
  current: TurnWindow,
  result: PiSyncResult
): TurnWindow {
  const byIndex = new Map(
    current.metas.map((meta) => [meta.absoluteIndex, meta])
  );
  for (const meta of result.metas) {
    byIndex.set(meta.absoluteIndex, meta);
  }
  const metas = [...byIndex.values()].sort(
    (left, right) => left.absoluteIndex - right.absoluteIndex
  );
  const total = Math.max(current.total, result.totalTurns);
  if (result.fromTurn < 0) {
    return { ...current, metas, total };
  }
  const cut = result.fromTurn - current.start;
  if (cut < 0 || cut > current.turns.length) {
    return { ...current, metas, total };
  }
  const appended = toTurns(result.messages as ChatMessage[], result.fromTurn);
  const turns = [...current.turns.slice(0, cut), ...appended];
  return {
    ...current,
    end: result.fromTurn + appended.length,
    metas,
    total,
    turns,
  };
}

async function loadUntilTurn(
  current: TurnWindow,
  targetAbsoluteIndex: number,
  loadOlder: () => Promise<TurnWindow | undefined>
): Promise<TurnWindow | undefined> {
  if (targetAbsoluteIndex >= current.start || !current.hasOlder) {
    return current;
  }
  const next = await loadOlder();
  if (!next || next.start >= current.start) {
    return;
  }
  return loadUntilTurn(next, targetAbsoluteIndex, loadOlder);
}

function useFileCompletion(
  api: omoApi,
  sessionCwd: string | undefined,
  completion: CompletionContext | null
) {
  const [fileEntries, setFileEntries] = useState<FileEntry[]>([]);
  const [fileLoading, setFileLoading] = useState(false);
  const fileQuery =
    completion?.kind === "file"
      ? completion.query.replace(backslashes, "/")
      : "";

  useEffect(() => {
    if (!sessionCwd || completion?.kind !== "file") {
      setFileEntries([]);
      setFileLoading(false);
      return;
    }
    const slash = fileQuery.lastIndexOf("/");
    const directory = fileQuery.slice(0, slash + 1);
    let active = true;
    setFileLoading(true);
    setFileEntries([]);
    api.fs
      .list(joinWorkspacePath(sessionCwd, directory))
      .then((entries) => {
        if (active) {
          setFileEntries(entries);
        }
      })
      .catch(() => {
        if (active) {
          setFileEntries([]);
        }
      })
      .finally(() => {
        if (active) {
          setFileLoading(false);
        }
      });
    return () => {
      active = false;
    };
  }, [api, completion?.kind, fileQuery, sessionCwd]);

  return { fileEntries, fileLoading, fileQuery };
}

function handlePiEvent(
  event: OmoPiEvent,
  sessionId: string,
  setStreaming: (value: boolean) => void,
  setWindow: (next: TurnWindow) => void
) {
  if (event.type === "message_start" && event.message?.role === "assistant") {
    setStreaming(true);
  }
  if (event.type === "agent_end") {
    setStreaming(false);
    const current = windows.get(sessionId);
    if (current) {
      completeLastAssistant(current, setWindow);
    }
    return;
  }
  const current = windows.get(sessionId);
  if (!current) {
    return;
  }
  const next = cloneTurnWindow(current);
  const last = next.turns.at(-1);
  if (!last) {
    return;
  }
  last.items = adaptPiEventBlocks(last, event);
  setWindow(next);
}

function adaptPiEventBlocks(
  turn: ConversationTurn,
  event: OmoPiEvent
): ConversationTurn["items"] {
  const blocks = adaptPiEvent(adaptPiMessages(turn.items), event);
  const byId = new Map<string, ConversationTurn["items"][number]>();
  for (const block of blocks) {
    if (block.type === "markdown") {
      byId.set(block.id, {
        id: block.id,
        role: "assistant",
        text: block.content,
        timestamp: block.timestamp,
      });
    } else if (block.type === "reasoning") {
      byId.set(block.id, {
        id: block.id,
        role: "thinking",
        status: block.status,
        text: block.content,
      });
    } else if (block.type === "tool-call") {
      byId.set(block.id, {
        id: block.id,
        input: block.input,
        output: block.output,
        role: "tool",
        status: block.status,
        toolName: block.toolName,
      });
    }
  }
  return [...byId.values()];
}

function ProjectSelect({
  projects,
  value,
  onSelect,
  onAdd,
  onClear,
}: {
  projects: Project[];
  value: string;
  onSelect: (project: Project) => void;
  onAdd: () => void;
  onClear: () => void;
}) {
  const { t } = useI18n();
  const projectItems = projects.map((project) => ({
    label: project.name,
    value: project.id,
  }));
  const actions = [
    { label: t("new_project"), value: "__new" },
    { label: t("no_project"), value: "__none" },
  ];
  const items = [...projectItems, ...actions];
  return (
    <Select
      items={items}
      itemToStringValue={(item) => item.value}
      onValueChange={(item) => {
        if (!item) {
          return;
        }
        if (item.value === "__new") {
          onAdd();
        } else if (item.value === "__none") {
          onClear();
        } else {
          const project = projects.find((entry) => entry.id === item.value);
          if (project) {
            onSelect(project);
          }
        }
      }}
      value={items.find((item) => item.value === value) ?? null}
    >
      <SelectTrigger className="w-fit min-w-0 max-w-xs" hideIcon size="sm">
        <HugeiconsIcon className="size-3.5" icon={Folder01Icon} />
        <SelectValue placeholder={t("choose_project")}>
          {projects.find((project) => project.id === value)?.name}
        </SelectValue>
      </SelectTrigger>
      <SelectContent
        alignItemWithTrigger={false}
        className="min-w-56 p-1"
        side="top"
        sideOffset={6}
      >
        {projectItems.map((item) => (
          <SelectItem key={item.value} value={item}>
            <span className="flex min-w-0 items-center gap-2">
              <HugeiconsIcon
                className="size-4 shrink-0 text-muted-foreground"
                icon={Folder01Icon}
              />
              <span className="whitespace-nowrap">{item.label}</span>
            </span>
          </SelectItem>
        ))}
        {!!projectItems.length && (
          <SelectSeparator className="my-1 bg-accent" />
        )}
        <SelectItem className="text-foreground/80" value={actions[0]}>
          <span className="flex items-center gap-2">
            <HugeiconsIcon className="size-4" icon={FolderAddIcon} />{" "}
            {t("new_project")}
          </span>
        </SelectItem>
        <SelectItem className="text-foreground/80" value={actions[1]}>
          <span className="flex items-center gap-2">
            <HugeiconsIcon className="size-4" icon={Cancel01Icon} />{" "}
            {t("no_project")}
          </span>
        </SelectItem>
      </SelectContent>
    </Select>
  );
}

function formatContextTokens(count: number): string {
  if (count >= 1_000_000) {
    return `${(count / 1_000_000).toFixed(1)}M`;
  }
  if (count >= 1000) {
    return `${(count / 1000).toFixed(count >= 100_000 ? 0 : 1)}K`;
  }
  return String(count);
}

/**
 * Context-window usage ring next to the reasoning selector. Pure indicator:
 * a circular progress ring tinted by usage, with the exact token counts in
 * the tooltip.
 */
function ContextUsageRing({
  usage,
  contextWindow,
}: {
  usage: PiContextUsage | null;
  contextWindow?: number;
}) {
  const { t } = useI18n();
  if (!usage) {
    return null;
  }
  const total = contextWindow ?? usage.contextWindow;
  const percent =
    usage.tokens === null || total <= 0
      ? (usage.percent ?? 0)
      : (usage.tokens / total) * 100;
  let tone = "text-muted-foreground";
  if (percent >= 90) {
    tone = "text-destructive";
  } else if (percent >= 70) {
    tone = "text-warning";
  }
  const radius = 8.5;
  const circumference = 2 * Math.PI * radius;
  const filled = (circumference * Math.min(100, Math.max(0, percent))) / 100;
  const detail =
    usage.tokens === null
      ? t("context_usage_unknown")
      : t("context_usage_detail", {
          percent: String(Math.round(percent)),
          total: formatContextTokens(total),
          used: formatContextTokens(usage.tokens),
        });
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            aria-label={`${t("context_usage")}: ${detail}`}
            className="size-7 min-h-0 rounded-full"
            size="icon-xs"
            variant="ghost"
          />
        }
      >
        <svg
          aria-hidden="true"
          className="size-5 -rotate-90"
          viewBox="0 0 22 22"
        >
          <circle
            className="stroke-border"
            cx="11"
            cy="11"
            fill="none"
            r={radius}
            strokeWidth="2.5"
          />
          <circle
            className={cn("transition-[stroke-dasharray] duration-300", tone)}
            cx="11"
            cy="11"
            fill="none"
            r={radius}
            stroke="currentColor"
            strokeDasharray={`${filled} ${circumference}`}
            strokeLinecap="round"
            strokeWidth="2.5"
          />
        </svg>
      </TooltipTrigger>
      <TooltipContent side="top">
        <span>{detail}</span>
      </TooltipContent>
    </Tooltip>
  );
}

interface ModelOption {
  id: string;
  label: string;
  name: string;
  provider: string;
  value: string;
}

interface ModelGroup {
  items: ModelOption[];
  label: string;
  provider: string;
  value: string;
}

function ModelSelect({
  models,
  value,
  placeholder,
  onChange,
}: {
  models: { id: string; provider: string; name: string }[];
  value: string;
  placeholder: string;
  onChange: (value: string) => void;
}) {
  const { t } = useI18n();
  const modelItems = useMemo<ModelOption[]>(
    () =>
      models.map((item) => ({
        ...item,
        label: item.name,
        value: `${item.provider}/${item.id}`,
      })),
    [models]
  );
  // The session's active model (from pi) may not be in the enabled list;
  // synthesize an entry so the trigger shows the real model instead of the
  // placeholder.
  const selected = useMemo<ModelOption | undefined>(() => {
    const match = modelItems.find((item) => item.value === value);
    if (match || !value) {
      return match;
    }
    const slash = value.indexOf("/");
    const provider = slash > 0 ? value.slice(0, slash) : value;
    const id = slash > 0 ? value.slice(slash + 1) : value;
    return { id, label: id, name: id, provider, value };
  }, [modelItems, value]);
  const groups = useMemo<ModelGroup[]>(() => {
    const available =
      selected && !modelItems.some((item) => item.value === selected.value)
        ? [selected, ...modelItems]
        : modelItems;
    const byProvider = new Map<string, ModelOption[]>();
    for (const item of available) {
      const group = byProvider.get(item.provider);
      if (group) {
        group.push(item);
      } else {
        byProvider.set(item.provider, [item]);
      }
    }
    return [...byProvider].map(([provider, items]) => ({
      items,
      label: provider,
      provider,
      value: provider,
    }));
  }, [modelItems, selected]);

  return (
    <Combobox
      aria-label={placeholder}
      items={groups}
      onValueChange={(item) => {
        if (item) {
          onChange(item.value);
        }
      }}
      value={selected ?? null}
    >
      <ComboboxTrigger
        render={<SelectButton className="w-fit max-w-56" hideIcon size="sm" />}
        title={selected?.label ?? placeholder}
      >
        <ComboboxValue placeholder={placeholder}>
          {(item: ModelOption | null) =>
            item ? (
              <span className="flex min-w-0 items-center gap-1.5">
                <ProviderIcon className="shrink-0" provider={item.provider} />
                <span className="truncate">{item.label}</span>
              </span>
            ) : (
              <span className="text-muted-foreground">{placeholder}</span>
            )
          }
        </ComboboxValue>
      </ComboboxTrigger>
      <ComboboxPopup
        aria-label={placeholder}
        className="w-[min(18rem,calc(100vw-2rem))]"
        side="top"
        sideOffset={6}
      >
        <div className="border-b p-2">
          <ComboboxInput
            aria-label={t("search_models")}
            placeholder={t("search_models")}
            showTrigger={false}
            size="sm"
            startAddon={<HugeiconsIcon icon={Search01Icon} />}
          />
        </div>
        <ComboboxEmpty>{t("models_no_results")}</ComboboxEmpty>
        <ComboboxList>
          {(group: ModelGroup, index) => (
            <Fragment key={group.value}>
              {index > 0 ? <ComboboxSeparator /> : null}
              <ComboboxGroup items={group.items}>
                <ComboboxGroupLabel className="flex items-center gap-1.5">
                  <ProviderIcon
                    className="size-3.5 shrink-0"
                    provider={group.provider}
                  />
                  {group.label}
                </ComboboxGroupLabel>
                <ComboboxCollection>
                  {(item: ModelOption) => (
                    <ComboboxItem
                      className="min-h-7 max-w-full overflow-hidden rounded-md text-xs"
                      key={item.value}
                      title={item.name}
                      value={item}
                    >
                      <span className="flex min-w-0 items-center gap-2">
                        <ProviderIcon
                          className="size-3.5 shrink-0"
                          provider={item.provider}
                        />
                        <span className="truncate">{item.name}</span>
                      </span>
                    </ComboboxItem>
                  )}
                </ComboboxCollection>
              </ComboboxGroup>
            </Fragment>
          )}
        </ComboboxList>
      </ComboboxPopup>
    </Combobox>
  );
}

function CompactSelect({
  items,
  value,
  placeholder,
  icon,
  disabled,
  appearance = "context",
  contentLabel,
  addLabel,
  onAdd,
  onChange,
}: {
  items: { value: string; label: string; icon?: React.ReactNode }[];
  value: string;
  placeholder?: string;
  icon?: React.ReactNode;
  disabled?: boolean;
  appearance?: "context" | "composer";
  contentLabel?: string;
  addLabel?: string;
  onAdd?: () => void;
  onChange: (value: string) => void;
}) {
  const selectedLabel = items.find((item) => item.value === value)?.label;
  const triggerContent = (
    <>
      {icon}
      <SelectValue placeholder={placeholder}>{selectedLabel}</SelectValue>
    </>
  );
  return (
    <Select
      disabled={disabled}
      items={items}
      itemToStringValue={(item) => item.value}
      onValueChange={(next) => next && onChange(next.value)}
      value={items.find((item) => item.value === value) ?? null}
    >
      {appearance === "composer" ? (
        <AiAgentInputSelectTrigger
          aria-label={
            contentLabel && selectedLabel
              ? `${contentLabel}: ${selectedLabel}`
              : contentLabel
          }
          hideIcon
          title={
            contentLabel && selectedLabel
              ? `${contentLabel}: ${selectedLabel}`
              : contentLabel
          }
        >
          {triggerContent}
        </AiAgentInputSelectTrigger>
      ) : (
        <SelectTrigger className="w-fit min-w-0 max-w-xs" hideIcon size="sm">
          {triggerContent}
        </SelectTrigger>
      )}
      <SelectContent
        alignItemWithTrigger={false}
        className={cn(
          appearance === "composer" ? "min-w-40 p-1" : "min-w-44 p-1"
        )}
        side="top"
        sideOffset={6}
      >
        <SelectGroup>
          {contentLabel ? <SelectLabel>{contentLabel}</SelectLabel> : null}
          {items.map((item) => (
            <SelectItem
              className={cn(appearance === "composer" ? "text-xs" : "text-sm")}
              key={item.value}
              value={item}
            >
              <span className="flex min-w-0 items-center gap-1.5">
                {item.icon}
                <span className="truncate">{item.label}</span>
              </span>
            </SelectItem>
          ))}
        </SelectGroup>
        {onAdd ? (
          <>
            <SelectSeparator className="mx-1 my-0.5" />
            <Button
              className="h-7 w-full justify-start gap-1.5 rounded-md px-2 font-normal text-muted-foreground text-xs hover:text-foreground"
              onClick={onAdd}
              type="button"
              variant="ghost"
            >
              <HugeiconsIcon className="size-3.5" icon={Add01Icon} />
              {addLabel}
            </Button>
          </>
        ) : null}
      </SelectContent>
    </Select>
  );
}
