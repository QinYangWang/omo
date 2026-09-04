import {
  Add01Icon,
  AiBrain01Icon,
  ArrowUp02Icon,
  FileAttachmentIcon,
  Image01Icon,
  StopIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import {
  Asterisk,
  ChevronRight,
  Copy,
  File,
  Folder,
  FolderPlus,
  GitBranch,
  LoaderCircle,
  Monitor,
  Search,
  X,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
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
import {
  copyToClipboard,
  formatDuration,
  formatTime,
  ImagePreviews,
  TurnCard,
} from "@/components/chat/turn-card";
import { ProviderIcon } from "@/components/provider-icon";
import { Button } from "@/components/ui/button";
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
  InputGroup,
  InputGroupAddon,
  InputGroupInput,
} from "@/components/ui/input-group";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectSeparator,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";
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
  toTurns,
  type TurnWindow,
  windowFromMessages,
} from "@/lib/conversation-turns";
import { useI18n } from "@/lib/i18n";
import { adaptPiEvent, adaptPiMessages } from "@/lib/pi-adapter";
import { getServerApi } from "@/lib/servers";
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
const OUTLINE_MAX_VISIBLE = 24;
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
const trailingSlashes = /[\\/]+$/;
const leadingSlashes = /^[/\\]+/;
const backslashes = /\\/g;
const commandPattern = /^\/([^\s]*)$/;
const filePattern = /(?:^|\s)@([^\s]*)$/;
const lunaPattern = /luna/i;
const noop = () => undefined;

const imageSource = (image: ImageContent) =>
  image.data.startsWith("data:")
    ? image.data
    : `data:${image.mimeType};base64,${image.data}`;
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
  const fileText: string[] = [];
  const results = await Promise.all(
    files.map(async (file) => ({
      file,
      result: await api.fs.read(file.path, file.image),
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
    } else if (result.content !== undefined) {
      fileText.push(`<file name="${file.path}">\n${result.content}\n</file>\n`);
    }
  }
  return { images: attachedImages, text: `${fileText.join("")}${value}` };
}


const completionIcon = (directory?: boolean) => (directory ? Folder : File);

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
          <LoaderCircle className="size-3.5 animate-spin" />
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
              {Icon ? <Icon data-icon="inline-start" /> : null}
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

export function ChatView({
  session,
  projects,
  onSelectProject,
  onRequestAddProject,
  onClearProject,
}: {
  session: ActiveSession | null;
  projects: Project[];
  onSelectProject: (project: Project) => void;
  onRequestAddProject: () => void;
  onClearProject: () => void;
}) {
  const { t } = useI18n();
  const api = getServerApi(session?.serverId);
  const key = session?.key ?? "draft";
  const sessionCwd = session?.cwd;
  const sessionPath = session?.path;
  const [turnWindow, setTurnWindow] = useState<TurnWindow>(
    () => windows.get(key) ?? windowFromMessages([], 0, false)
  );
  const [streaming, setStreaming] = useState(false);
  const [loading, setLoading] = useState(false);
  const [mode, setMode] = useState<"local" | "worktree">("local");
  const [branches, setBranches] = useState<
    { name: string; current: boolean }[]
  >([]);
  const [models, setModels] = useState<
    { id: string; provider: string; name: string }[]
  >([]);
  const [model, setModel] = useState("");
  const [thinking, setThinking] = useState("max");
  const [text, setText] = useState("");
  const [images, setImages] = useState<ImageAttachment[]>([]);
  const [fileAttachments, setFileAttachments] = useState<FileAttachment[]>([]);
  const [commands, setCommands] = useState<SlashCommand[]>([]);
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
  const sessionPathRef = useRef(sessionPath);
  sessionPathRef.current = sessionPath;
  const streamingRef = useRef(false);
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
      windows.set(key, next);
      setTurnWindow((current) => (keyRef.current === key ? next : current));
    },
    [key]
  );

  const loadHistoryPage = (): Promise<TurnWindow | undefined> => {
    const targetKey = keyRef.current;
    const inFlight = loadingOlder.current;
    if (inFlight?.key === targetKey) {
      return inFlight.promise;
    }
    const current = windows.get(targetKey) ?? turnWindow;
    if (!(session && current.hasOlder)) {
      return Promise.resolve(undefined);
    }
    const promise = (async () => {
      try {
        const result = await api.pi.history(targetKey, current.startCursor);
        if (keyRef.current !== targetKey) {
          return;
        }
        const latest = windows.get(targetKey) ?? current;
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
      let current = windows.get(keyRef.current) ?? turnWindow;
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
    loadSession(
      api,
      key,
      sessionCwd,
      sessionPath,
      setTurnWindow,
      setWindow,
      setLoading,
      setModel,
      setThinking
    );
  }, [api, key, sessionCwd, sessionPath, setWindow]);

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

  useEffect(() => {
    if (!sessionCwd) {
      return setBranches([]);
    }
    api.git.branches(sessionCwd).then(setBranches);
  }, [api, sessionCwd]);

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
      description: entry.dir ? "Folder" : undefined,
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
    streamingRef.current = streaming;
  }, [streaming]);

  // Merge file-based sync (TUI or external writes) into the window.
  const syncFromFile = useCallback(async () => {
    const targetKey = keyRef.current;
    const path = sessionPathRef.current;
    if (!path || streamingRef.current) {
      return;
    }
    const current = windows.get(targetKey) ?? turnWindow;
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
      const latest = windows.get(targetKey) ?? current;
      setWindow(mergeSyncResult(latest, result));
    } catch {
      // Sync is best effort; the next file change retries.
    }
  }, [api, setWindow, turnWindow]);

  useEffect(() => {
    const unsubscribe = api.pi.onEvent(({ sessionId: sid, event }) => {
      if (sid !== keyRef.current) {
        return;
      }
      if (event.type === "omo_session_file") {
        // Session JSONL changed on disk (e.g. the same session is active in
        // the pi TUI). Debounce and re-read the tail from disk.
        if (streamingRef.current) {
          return;
        }
        clearTimeout(syncTimer.current);
        syncTimer.current = setTimeout(() => {
          syncFromFile().catch(() => undefined);
        }, 300);
        return;
      }
      handlePiEvent(event, keyRef.current, setStreaming, setWindow);
    });
    return unsubscribe;
  }, [api, setWindow, syncFromFile]);

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
    const current = windows.get(key) ?? turnWindow;
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
      const promptImages = prepared.images.map(({ type, data, mimeType }) => ({
        data,
        mimeType,
        type,
      }));
      try {
        await api.pi.prompt(
          key,
          prepared.text,
          session.cwd,
          session.path,
          promptImages
        );
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
      onChangeMode={(value) => setMode(value as "local" | "worktree")}
      onChangeModel={(value) => {
        setModel(value);
        const selected = models.find(
          (item) => `${item.provider}/${item.id}` === value
        );
        if (session && selected) {
          api.pi.setModel(key, selected.provider, selected.id);
        }
      }}
      onChangeThinking={(value) => {
        setThinking(value);
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
        <LoaderCircle className="size-5 animate-spin" />
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
      <div className="flex h-full flex-col overflow-hidden">
        <Empty className="min-h-0 p-8">
          <EmptyHeader>
            <EmptyMedia>
              <Asterisk className="size-7" strokeWidth={1.6} />
            </EmptyMedia>
            <EmptyTitle>{session.title || t("new_task")}</EmptyTitle>
            <EmptyDescription>
              {t("working_in_project", { name: session.project })}
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
        <div className="mx-auto w-full max-w-3xl p-4">{input}</div>
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
      <div className="mx-auto w-full max-w-3xl p-4">{input}</div>
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
    <Empty className="h-full rounded-none p-6">
      <EmptyHeader>
        <EmptyMedia>
          <Folder className="size-6" />
        </EmptyMedia>
        <EmptyTitle>{t("choose_project_start")}</EmptyTitle>
        <EmptyDescription>{t("choose_project_desc")}</EmptyDescription>
      </EmptyHeader>
      <EmptyContent className="w-full max-w-sm gap-1">
        {visibleProjects.map((project) => (
          <Button
            className="h-auto w-full justify-between px-3 py-2 text-left"
            key={project.id}
            onClick={() => onSelectProject(project)}
            variant="ghost"
          >
            <span className="flex min-w-0 items-center gap-3">
              <Folder data-icon="inline-start" />
              <span className="min-w-0">
                <span className="block truncate font-medium text-sm">
                  {project.name}
                </span>
                <span className="block truncate text-muted-foreground text-xs">
                  {project.cwd}
                </span>
              </span>
            </span>
            <ChevronRight data-icon="inline-end" />
          </Button>
        ))}
        <Button
          className="mt-2 w-full"
          onClick={onAddProject}
          variant={projects.length ? "outline" : "default"}
        >
          <FolderPlus data-icon="inline-start" />
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
  models: { id: string; name: string; provider: string }[];
  onAbort: () => Promise<void>;
  onAddProject: () => void;
  onAttachImages: (files: File[]) => Promise<void>;
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
      <div className="mb-2 flex h-7 items-center gap-1 px-1 text-muted-foreground text-xs">
        <ProjectSelect
          onAdd={onAddProject}
          onClear={onClearProject}
          onSelect={onSelectProject}
          projects={projects}
          value={session?.projectId ?? ""}
        />
        <CompactSelect
          icon={<Monitor className="size-3.5" />}
          items={[
            { label: t("local"), value: "local" },
            { label: t("worktree"), value: "worktree" },
          ]}
          onChange={onChangeMode}
          value={mode}
        />
        <CompactSelect
          disabled={!branches.length}
          icon={<GitBranch className="size-3.5" />}
          items={branches.map((branch) => ({
            label: branch.name,
            value: branch.name,
          }))}
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
                    className="group h-[22px] max-w-full rounded-full px-2 text-xs"
                    key={file.id}
                    onClick={() => onFileRemove(file)}
                    title={file.path}
                    variant="outline"
                  >
                    <File data-icon="inline-start" />
                    <span className="truncate">@{file.display}</span>
                    <X data-icon="inline-end" />
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
                  <HugeiconsIcon
                    data-icon="inline-start"
                    icon={Add01Icon}
                    strokeWidth={1.8}
                  />
                </DropdownMenuTrigger>
                <DropdownMenuContent
                  align="start"
                  className="w-44 rounded-[10px] p-[3px] text-xs"
                  side="top"
                >
                  <DropdownMenuGroup>
                    <DropdownMenuItem
                      onClick={() => imageInput.current?.click()}
                    >
                      <HugeiconsIcon icon={Image01Icon} strokeWidth={1.8} />
                      {t("attach_images")}
                    </DropdownMenuItem>
                    <DropdownMenuItem onClick={openWorkspaceFile}>
                      <HugeiconsIcon
                        icon={FileAttachmentIcon}
                        strokeWidth={1.8}
                      />
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
                icon={<HugeiconsIcon icon={AiBrain01Icon} strokeWidth={1.8} />}
                items={[
                  { label: t("thinking_level_off"), value: "off" },
                  { label: t("thinking_level_minimal"), value: "minimal" },
                  { label: t("thinking_level_low"), value: "low" },
                  { label: t("thinking_level_medium"), value: "medium" },
                  { label: t("thinking_level_high"), value: "high" },
                  { label: t("thinking_level_extra_high"), value: "xhigh" },
                  { label: t("thinking_level_maximum"), value: "max" },
                ]}
                onChange={onChangeThinking}
                value={thinking}
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
                <HugeiconsIcon
                  data-icon="inline-start"
                  icon={StopIcon}
                  strokeWidth={2}
                />
              ) : (
                <HugeiconsIcon
                  data-icon="inline-start"
                  icon={ArrowUp02Icon}
                  strokeWidth={2}
                />
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
  sessionCwd: string | undefined,
  sessionPath: string | undefined,
  setTurnWindow: (next: TurnWindow) => void,
  setWindow: (next: TurnWindow) => void,
  setLoading: (value: boolean) => void,
  setModel: (value: string) => void,
  setThinking: (value: string) => void
) {
  const cached = windows.get(key);
  setTurnWindow(cached ?? windowFromMessages([], 0, false));
  if (cached) {
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
    } = await api.pi.open(key, sessionCwd, sessionPath);
    setWindow(
      windowFromMessages(history as ChatMessage[], cursor, hasMore, outline)
    );
    if (sessionModel) {
      setModel(`${sessionModel.provider}/${sessionModel.id}`);
    }
    if (thinkingLevel) {
      setThinking(thinkingLevel);
    }
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
      <SelectTrigger
        className="h-6 min-h-0 w-fit min-w-0 max-w-none justify-start gap-1 rounded-[7px] border-0 bg-transparent px-2 text-[11px] text-muted-foreground shadow-none transition-none before:shadow-none hover:bg-accent hover:text-foreground focus-visible:border-transparent focus-visible:ring-0 sm:min-h-0"
        hideIcon
      >
        <Folder className="size-3.5" />
        <SelectValue placeholder={t("choose_project")}>
          {projects.find((project) => project.id === value)?.name}
        </SelectValue>
      </SelectTrigger>
      <SelectContent
        alignItemWithTrigger={false}
        className="min-w-56 p-1"
        sideOffset={6}
      >
        {projectItems.map((item) => (
          <SelectItem
            className="min-h-8 rounded-md text-sm"
            key={item.value}
            value={item}
          >
            <span className="flex min-w-0 items-center gap-2">
              <Folder className="size-4 shrink-0 text-muted-foreground" />
              <span className="whitespace-nowrap">{item.label}</span>
            </span>
          </SelectItem>
        ))}
        {!!projectItems.length && (
          <SelectSeparator className="my-1 bg-accent" />
        )}
        <SelectItem
          className="min-h-8 rounded-md text-foreground/80 text-sm"
          value={actions[0]}
        >
          <span className="flex items-center gap-2">
            <FolderPlus className="size-4" /> {t("new_project")}
          </span>
        </SelectItem>
        <SelectItem
          className="min-h-8 rounded-md text-foreground/80 text-sm"
          value={actions[1]}
        >
          <span className="flex items-center gap-2">
            <X className="size-4" /> {t("no_project")}
          </span>
        </SelectItem>
      </SelectContent>
    </Select>
  );
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
  const modelItems = models.map((item) => ({
    ...item,
    label: item.name,
    value: `${item.provider}/${item.id}`,
  }));
  const selected = modelItems.find((item) => item.value === value);
  const groups = [...new Set(modelItems.map((item) => item.provider))];
  const [expanded, setExpanded] = useState<Set<string>>(
    () => new Set(selected ? [selected.provider] : groups)
  );
  const [query, setQuery] = useState("");
  const selectedProvider = selected?.provider;
  useEffect(() => {
    if (!selectedProvider) {
      return;
    }
    setExpanded((current) => {
      if (current.has(selectedProvider)) {
        return current;
      }
      const next = new Set(current);
      next.add(selectedProvider);
      return next;
    });
  }, [selectedProvider]);
  const filtered = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    const matched = normalized
      ? modelItems.filter((item) =>
          `${item.provider} ${item.label}`.toLowerCase().includes(normalized)
        )
      : modelItems;
    return selected && !matched.some((item) => item.value === selected.value)
      ? [selected, ...matched]
      : matched;
  }, [modelItems, query, selected]);
  const filteredGroups = [...new Set(filtered.map((item) => item.provider))];
  return (
    <Select
      items={filtered}
      itemToStringValue={(item) => item.label}
      onOpenChange={(open) => {
        if (!open) {
          setQuery("");
        }
      }}
      onValueChange={(item) => {
        if (item) {
          onChange(item.value);
          setQuery("");
        }
      }}
      value={selected}
    >
      <AiAgentInputSelectTrigger title={selected?.label}>
        <ProviderIcon className="shrink-0" provider={selected?.provider} />
        <SelectValue placeholder={placeholder}>{selected?.label}</SelectValue>
      </AiAgentInputSelectTrigger>
      <SelectContent
        alignItemWithTrigger={false}
        className="max-h-[min(17.5rem,47vh)] w-[min(14.375rem,calc(100vw-2rem))] overflow-hidden rounded-[10px] bg-popover p-0"
        side="top"
        sideOffset={6}
      >
        <div className="flex max-h-[min(17.5rem,47vh)] flex-col">
          <div className="shrink-0 p-[3px] pb-0">
            <InputGroup className="h-8 rounded-[7px] border-0 bg-muted shadow-none">
              <InputGroupAddon>
                <Search />
              </InputGroupAddon>
              <InputGroupInput
                onChange={(event) => setQuery(event.target.value)}
                onKeyDown={(event) => event.stopPropagation()}
                placeholder={t("search_models")}
                value={query}
              />
            </InputGroup>
          </div>
          <Separator className="my-[3px]" />
          <div className="min-h-0 overflow-y-auto px-[3px] pb-[3px]">
            {filteredGroups.map((provider, index) => (
              <SelectGroup className="scroll-my-0 p-0" key={provider}>
                {index > 0 && <SelectSeparator className="mx-1 my-0.5" />}
                <SelectLabel
                  className="flex min-h-7 w-full cursor-pointer items-center justify-start gap-1.5 rounded-md px-2 py-1 text-left font-medium text-muted-foreground text-xs hover:bg-accent hover:text-foreground"
                  onClick={(event) => {
                    event.preventDefault();
                    setExpanded((current) => {
                      const next = new Set(current);
                      if (next.has(provider)) {
                        next.delete(provider);
                      } else {
                        next.add(provider);
                      }
                      return next;
                    });
                  }}
                  render={<button type="button" />}
                >
                  <ChevronRight
                    className={`size-3 shrink-0 transition-transform ${expanded.has(provider) || query ? "rotate-90" : ""}`}
                  />
                  <ProviderIcon
                    className="size-3.5 shrink-0"
                    provider={provider}
                  />
                  {provider}
                </SelectLabel>
                {(expanded.has(provider) || !!query) &&
                  filtered
                    .filter((item) => item.provider === provider)
                    .map((item) => (
                      <SelectItem
                        className="min-h-7 max-w-full overflow-hidden rounded-md pr-7 pl-7 text-xs [&>span:first-child]:min-w-0 [&>span:first-child]:shrink [&>span:first-child]:overflow-hidden"
                        key={`${item.provider}/${item.id}`}
                        title={item.name}
                        value={item}
                      >
                        <span className="min-w-0 truncate">{item.name}</span>
                      </SelectItem>
                    ))}
              </SelectGroup>
            ))}
            {filtered.length === 0 && (
              <div className="px-3 py-2 text-muted-foreground text-sm">
                {t("models_no_results")}
              </div>
            )}
          </div>
        </div>
      </SelectContent>
    </Select>
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
  onChange,
}: {
  items: { value: string; label: string }[];
  value: string;
  placeholder?: string;
  icon?: React.ReactNode;
  disabled?: boolean;
  appearance?: "context" | "composer";
  contentLabel?: string;
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
          title={
            contentLabel && selectedLabel
              ? `${contentLabel}: ${selectedLabel}`
              : contentLabel
          }
        >
          {triggerContent}
        </AiAgentInputSelectTrigger>
      ) : (
        <SelectTrigger
          className="h-6 min-h-0 w-fit min-w-0 max-w-none justify-start gap-1 rounded-[7px] border-0 bg-transparent px-1.5 text-[11px] text-muted-foreground shadow-none transition-none before:shadow-none hover:bg-accent hover:text-foreground focus-visible:border-transparent focus-visible:ring-0 sm:min-h-0"
          hideIcon
        >
          {triggerContent}
        </SelectTrigger>
      )}
      <SelectContent
        alignItemWithTrigger={false}
        className={cn(
          appearance === "composer"
            ? "min-w-40 rounded-[10px] p-[3px]"
            : "min-w-44 p-1"
        )}
        side={appearance === "composer" ? "top" : "bottom"}
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
              {item.label}
            </SelectItem>
          ))}
        </SelectGroup>
      </SelectContent>
    </Select>
  );
}
