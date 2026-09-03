import {
  Asterisk,
  Check,
  ChevronRight,
  Copy,
  File,
  Folder,
  FolderPlus,
  Gauge,
  GitBranch,
  LoaderCircle,
  Monitor,
  Search,
  Slash,
  X,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { type ListRange, Virtuoso, type VirtuosoHandle } from "react-virtuoso";
import { RenderBlocks } from "@/components/chat/render-blocks";
import { ProviderIcon } from "@/components/provider-icon";
import { Button } from "@/components/ui/button";
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
import {
  appendMessages,
  type ChatMessage,
  type ConversationTurn,
  type ImageContent,
  prependWindow,
  type TurnWindow,
  windowFromMessages,
} from "@/lib/conversation-turns";
import { useI18n } from "@/lib/i18n";
import { omo } from "@/lib/omo";
import {
  adaptPiEvent,
  adaptPiMessages,
  type RenderBlock,
} from "@/lib/pi-adapter";

interface ActiveSession {
  cwd: string;
  key: string;
  path?: string;
  project: string;
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
            id: crypto.randomUUID(),
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
    id: crypto.randomUUID(),
    mimeType: source.type || file.type || "image/png",
    name: file.name || "clipboard-image",
    type: "image",
  };
}

async function preparePrompt(
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
      result: await omo.fs.read(file.path, file.image),
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

function ImagePreviews({
  images,
  onRemove,
}: {
  images: ImageContent[];
  onRemove?: (id: string) => void;
}) {
  if (!images.length) {
    return null;
  }
  return (
    <div className="flex flex-wrap gap-2">
      {images.map((image, index) => (
        <div
          className="group relative overflow-hidden rounded-xl border border-border bg-muted"
          key={image.name ? `${image.name}-${index}` : index}
        >
          <img
            alt={image.name || "Attached image"}
            className="size-20 object-cover"
            height={80}
            src={imageSource(image)}
            width={80}
          />
          {onRemove ? (
            <button
              aria-label={`Remove ${image.name || "image"}`}
              className="absolute top-1 right-1 rounded-full bg-background/90 p-1 text-muted-foreground opacity-0 shadow transition-opacity focus-visible:opacity-100 group-hover:opacity-100"
              onClick={() => onRemove((image as ImageAttachment).id)}
              title="Remove image"
              type="button"
            >
              <X className="size-3" />
            </button>
          ) : null}
        </div>
      ))}
    </div>
  );
}

const completionIcon = (kind: "file" | "command", directory?: boolean) => {
  if (kind === "command") {
    return Slash;
  }
  return directory ? Folder : File;
};

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
  if (!(loading || items.length)) {
    return null;
  }
  return (
    <div
      aria-label={kind === "file" ? "Files" : "Commands"}
      className="absolute bottom-full left-0 z-20 mb-2 w-full max-w-md overflow-hidden rounded-2xl border border-border bg-popover p-1 text-popover-foreground shadow-lg"
      role="listbox"
    >
      {loading ? (
        <div className="flex items-center gap-2 px-3 py-2 text-muted-foreground text-xs">
          <LoaderCircle className="size-3.5 animate-spin" /> Loading…
        </div>
      ) : null}
      {items.map((item, index) => {
        const Icon = completionIcon(kind, item.directory);
        return (
          <button
            aria-selected={index === activeIndex}
            className={`flex w-full items-center gap-2 rounded-xl px-2.5 py-2 text-left text-sm ${index === activeIndex ? "bg-accent text-foreground" : "text-muted-foreground hover:bg-accent hover:text-foreground"}`}
            key={item.value}
            onClick={() => onSelect(item)}
            onMouseDown={(event) => event.preventDefault()}
            role="option"
            type="button"
          >
            <Icon className="size-4 shrink-0" />
            <span className="min-w-0 flex-1 truncate">
              {kind === "command" ? `/${item.label}` : item.label}
              {item.directory ? "/" : ""}
            </span>
            {item.description ? (
              <span className="max-w-[45%] truncate text-muted-foreground text-xs">
                {item.description}
              </span>
            ) : null}
          </button>
        );
      })}
      <div className="px-2.5 py-1 text-[11px] text-muted-foreground">
        ↑↓ select · Enter insert · Esc close
      </div>
    </div>
  );
}

const formatTime = (timestamp?: number) =>
  timestamp
    ? new Intl.DateTimeFormat("en-US", {
        hour: "numeric",
        hour12: true,
        minute: "2-digit",
        weekday: "long",
      }).format(timestamp)
    : "";

const formatDuration = (ms?: number) => {
  if (ms === undefined) {
    return "";
  }
  const minutes = ms / 60_000;
  return minutes < 1 ? "<1 min" : `${Math.round(minutes)} min`;
};

const copyToClipboard = async (text: string) => {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const textarea = document.createElement("textarea");
    textarea.value = text;
    textarea.setAttribute("readonly", "");
    textarea.style.position = "fixed";
    textarea.style.left = "-9999px";
    document.body.appendChild(textarea);
    textarea.select();
    document.execCommand("copy");
    textarea.remove();
  }
};

function Outline({
  metas,
  activeId,
  onJump,
}: {
  metas: TurnWindow["metas"];
  activeId?: string;
  onJump: (turnId: string) => void;
}) {
  if (!metas.length) {
    return null;
  }
  const activeIndex = metas.findIndex((meta) => meta.id === activeId);
  const maxVisible = 48;
  const start =
    activeIndex >= 0
      ? Math.max(
          0,
          Math.min(
            metas.length - maxVisible,
            activeIndex - Math.floor(maxVisible / 2)
          )
        )
      : Math.max(0, metas.length - maxVisible);
  const visible = metas.slice(start, start + maxVisible);
  return (
    <aside className="pointer-events-none absolute top-1/2 right-4 z-10 -translate-y-1/2">
      <div className="pointer-events-auto flex flex-col items-end justify-center gap-1.5 py-2">
        {visible.map((meta) => {
          const active = meta.id === activeId;
          return (
            <div
              className="group relative flex h-4 items-center justify-end"
              key={meta.id}
            >
              <button
                aria-label="Go to user message"
                className={`h-px w-4 rounded-full transition-all duration-150 ${
                  active ? "bg-foreground" : "bg-muted-foreground/40"
                } group-hover:w-10 group-hover:bg-foreground`}
                onClick={() => onJump(meta.id)}
                type="button"
              />
              <div className="pointer-events-none absolute top-1/2 right-12 hidden w-64 -translate-y-1/2 rounded-lg border border-border bg-popover p-3 text-left shadow-lg group-hover:block">
                <div className="mb-1 text-[11px] text-muted-foreground">
                  User message
                </div>
                <p className="line-clamp-4 whitespace-pre-wrap text-foreground text-xs leading-5">
                  {meta.userPreview}
                </p>
              </div>
            </div>
          );
        })}
      </div>
    </aside>
  );
}

function TurnCard({
  turn,
  highlighted,
}: {
  turn: ConversationTurn;
  highlighted?: boolean;
}) {
  const userBlock: RenderBlock = {
    content: turn.user.text,
    id: turn.user.id,
    timestamp: turn.user.timestamp,
    type: "markdown",
  };
  const blocks = [userBlock, ...adaptPiMessages(turn.items)];
  const answer = turn.items
    .flatMap((item) => (item.role === "assistant" ? [item.text] : []))
    .filter(Boolean)
    .join("\n\n");
  const completed = turn.items.find(
    (item) => item.role === "assistant" && item.turnEnd
  );

  return (
    <div className="mx-auto w-full max-w-3xl px-4 py-1">
      <div
        className={
          highlighted
            ? "rounded-lg bg-accent/30 transition-colors"
            : "transition-colors"
        }
      >
        <div className="flex justify-end">
          <div className="max-w-full rounded-2xl bg-secondary px-5 py-3 text-[15px] text-secondary-foreground leading-relaxed">
            {turn.user.images ? (
              <ImagePreviews images={turn.user.images} />
            ) : null}
            {turn.user.text ? <RenderBlocks blocks={[userBlock]} /> : null}
          </div>
        </div>
        <div className="mt-1 flex items-center justify-end gap-2 text-muted-foreground text-xs">
          <time>{formatTime(turn.user.timestamp)}</time>
          <button
            aria-label="Copy message"
            className="rounded p-1 opacity-60 hover:bg-accent hover:opacity-100"
            onClick={() =>
              copyToClipboard(turn.user.text).catch(() => undefined)
            }
            title="Copy message"
            type="button"
          >
            <Copy className="size-3.5" />
          </button>
        </div>
        <div className="mt-2 text-[15px] leading-relaxed">
          <RenderBlocks blocks={blocks.slice(1)} />
        </div>
        {completed?.role === "assistant" && (
          <div className="mt-2 flex items-center gap-2 text-muted-foreground text-xs">
            <button
              aria-label="Copy answer"
              className="rounded p-1 opacity-60 hover:bg-accent hover:opacity-100"
              onClick={() =>
                copyToClipboard(answer || completed.text).catch(() => undefined)
              }
              title="Copy full answer"
              type="button"
            >
              <Copy className="size-3.5" />
            </button>
            <time>{formatTime(completed.completedAt)}</time>
            {completed.durationMs === undefined ? null : (
              <span>· {formatDuration(completed.durationMs)}</span>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

export function ChatView({
  session,
  projects,
  onSelectProject,
  onAddProject,
  onClearProject,
}: {
  session: ActiveSession | null;
  projects: Project[];
  onSelectProject: (project: Project) => void;
  onAddProject: (path?: string) => Promise<Project | null | undefined>;
  onClearProject: () => void;
}) {
  const { t } = useI18n();
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
  const keyRef = useRef(key);
  keyRef.current = key;

  const turnIndex = new Map(
    turnWindow.turns.map((turn, index) => [turn.id, index])
  );
  const visibleTurn = visibleRange
    ? turnWindow.turns[
        Math.min(
          Math.max(0, visibleRange.startIndex),
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

  const loadOlder = async () => {
    const current = windows.get(keyRef.current) ?? turnWindow;
    if (!(session && current.hasOlder)) {
      return;
    }
    const result = await omo.pi.history(keyRef.current, current.startCursor);
    setWindow(
      prependWindow(
        current,
        result.messages as ChatMessage[],
        result.cursor,
        result.hasMore
      )
    );
  };

  const jumpTo = (turnId: string) => {
    const index = turnIndex.get(turnId);
    if (index === undefined) {
      return;
    }
    const currentIndex = visibleTurn
      ? (turnIndex.get(visibleTurn.id) ?? index)
      : index;
    const near = Math.abs(index - currentIndex) < 30;
    virtuoso.current?.scrollToIndex({
      align: "center",
      behavior: near ? "smooth" : "auto",
      index,
    });
    window.setTimeout(
      () =>
        virtuoso.current?.scrollToIndex({
          align: "center",
          behavior: "auto",
          index,
        }),
      near ? 350 : 80
    );
    setHighlightedId(turnId);
    window.setTimeout(
      () => setHighlightedId((id) => (id === turnId ? undefined : id)),
      1200
    );
  };

  useEffect(() => {
    loadSession(
      key,
      sessionCwd,
      sessionPath,
      setTurnWindow,
      setWindow,
      setLoading,
      setModel,
      setThinking
    );
  }, [key, sessionCwd, sessionPath, setWindow]);

  useEffect(() => {
    omo.pi.models().then((available) => {
      setModels(available);
      const preferred =
        available.find((item) => lunaPattern.test(item.name)) ?? available[0];
      if (preferred) {
        setModel(
          (current) => current || `${preferred.provider}/${preferred.id}`
        );
      }
    });
  }, []);

  useEffect(() => {
    if (!sessionCwd) {
      return setBranches([]);
    }
    omo.git.branches(sessionCwd).then(setBranches);
  }, [sessionCwd]);

  useEffect(() => {
    let active = true;
    setCommands([]);
    if (!sessionCwd) {
      return;
    }
    omo.pi
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
  }, [key, sessionCwd, sessionPath]);

  const { fileEntries, fileLoading, fileQuery } = useFileCompletion(
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
    const unsubscribe = omo.pi.onEvent(({ sessionId: sid, event }) => {
      if (sid !== keyRef.current) {
        return;
      }
      handlePiEvent(event, keyRef.current, setStreaming, setWindow);
    });
    return unsubscribe;
  }, [setWindow]);

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
    if (images.length >= MAX_IMAGE_ATTACHMENTS) {
      setInputError("Too many image attachments");
      return;
    }
    setInputError("");
    try {
      const attachment = await createImageAttachment(file);
      setImages((current) => [...current, attachment]);
    } catch (error) {
      setInputError(error instanceof Error ? error.message : String(error));
    }
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
      prepared = await preparePrompt(value, images, activeFiles);
    } catch (error) {
      setInputError(error instanceof Error ? error.message : String(error));
      return;
    }
    const current = windows.get(key) ?? turnWindow;
    const next = appendMessages(current, [
      {
        id: crypto.randomUUID(),
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
        await omo.pi.prompt(
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
      mode={mode}
      model={model}
      models={models}
      onAbort={async () => {
        try {
          await omo.pi.abort(key);
        } finally {
          setStreaming(false);
        }
      }}
      onAddProject={onAddProject}
      onChangeMode={(value) => setMode(value as "local" | "worktree")}
      onChangeModel={(value) => {
        setModel(value);
        const selected = models.find(
          (item) => `${item.provider}/${item.id}` === value
        );
        if (session && selected) {
          omo.pi.setModel(key, selected.provider, selected.id);
        }
      }}
      onChangeThinking={(value) => {
        setThinking(value);
        if (session) {
          omo.pi.setThinking(key, value);
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
    return (
      <div className="relative h-full overflow-hidden p-8">
        <div className="absolute top-[43%] left-1/2 -translate-x-1/2 -translate-y-1/2 text-center">
          <Asterisk
            className="mx-auto mb-5 size-7 text-orange-500"
            strokeWidth={1.6}
          />
          <div className="max-w-[70vw] truncate whitespace-nowrap font-normal text-xl">
            {session ? session.title : t("choose_project_start")}
          </div>
          {session ? (
            <div className="mt-1 text-muted-foreground text-sm">
              @ {session.project}
            </div>
          ) : null}
        </div>
        <div className="absolute bottom-5 left-1/2 w-[min(90%,760px)] -translate-x-1/2">
          {input}
        </div>
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
          followOutput="smooth"
          increaseViewportBy={{ bottom: 400, top: 400 }}
          itemContent={(_index, turn) => (
            <TurnCard highlighted={turn.id === highlightedId} turn={turn} />
          )}
          rangeChanged={setVisibleRange}
          ref={virtuoso}
          startReached={loadOlder}
        />
        <Outline
          activeId={visibleTurn?.id}
          metas={turnWindow.metas}
          onJump={jumpTo}
        />
      </div>
      <div className="mx-auto w-full max-w-3xl p-4">{input}</div>
    </div>
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
  mode: "local" | "worktree";
  model: string;
  models: { id: string; name: string; provider: string }[];
  onAbort: () => Promise<void>;
  onAddProject: (path?: string) => Promise<Project | null | undefined>;
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
  inputError,
  mode,
  model,
  models,
  onAbort,
  onAddProject,
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
  return (
    <div>
      <div className="mb-2 flex h-8 items-center gap-1 px-1 text-muted-foreground text-xs">
        <ProjectSelect
          onAdd={onAddProject}
          onClear={onClearProject}
          onSelect={onSelectProject}
          projects={projects}
          value={session?.cwd ?? ""}
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
        <form
          className="overflow-hidden rounded-3xl border border-border bg-background"
          onSubmit={onSubmit}
        >
          {images.length > 0 || fileAttachments.length > 0 ? (
            <div className="flex flex-wrap gap-2 px-4 pt-3 pb-1">
              <ImagePreviews images={images} onRemove={onImageRemove} />
              {fileAttachments.map((file) => (
                <button
                  className="group flex max-w-full items-center gap-1.5 rounded-xl border border-border bg-muted px-2 py-1.5 text-muted-foreground text-xs hover:bg-accent hover:text-foreground"
                  key={file.id}
                  onClick={() => onFileRemove(file)}
                  title={file.path}
                  type="button"
                >
                  <File className="size-3.5 shrink-0" />
                  <span className="truncate">@{file.display}</span>
                  <X className="size-3 shrink-0 opacity-60 group-hover:opacity-100" />
                </button>
              ))}
            </div>
          ) : null}
          <textarea
            className="h-12 w-full resize-none overflow-hidden border-0 bg-transparent px-4 py-4 text-[15px] outline-none placeholder:text-muted-foreground"
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
            value={text}
          />
          <div className="flex items-center justify-between gap-2 px-4 pt-0 pb-3">
            <div className="flex min-w-0 items-center gap-2">
              <ModelSelect
                models={models}
                onChange={onChangeModel}
                placeholder={t("select_model")}
                value={model}
              />
              <CompactSelect
                items={[
                  "off",
                  "minimal",
                  "low",
                  "medium",
                  "high",
                  "xhigh",
                  "max",
                ].map((value) => ({
                  label: value[0].toUpperCase() + value.slice(1),
                  value,
                }))}
                onChange={onChangeThinking}
                value={thinking}
              />
              <span className="hidden shrink-0 items-center gap-1.5 whitespace-nowrap px-2 text-muted-foreground text-xs lg:flex">
                <Gauge className="size-3.5" /> 32k / 128k context
              </span>
            </div>
            <Button
              className={
                streaming
                  ? "rounded-full border-0 bg-foreground text-background shadow-none hover:bg-foreground/90"
                  : "rounded-full border-0 bg-accent text-muted-foreground shadow-none hover:bg-accent hover:text-foreground disabled:opacity-40"
              }
              disabled={
                !(
                  streaming ||
                  text.trim() ||
                  images.length ||
                  fileAttachments.length
                )
              }
              onClick={streaming ? onAbort : undefined}
              size="icon-sm"
              type={streaming ? "button" : "submit"}
            >
              {streaming ? (
                <X className="size-4" />
              ) : (
                <Check className="size-4" />
              )}
            </Button>
          </div>
        </form>
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
  if (!sessionCwd || cached) {
    setLoading(false);
    return;
  }
  setLoading(true);
  try {
    const {
      messages: history,
      cursor,
      hasMore,
      model: sessionModel,
      thinkingLevel,
    } = await omo.pi.open(key, sessionCwd, sessionPath);
    setWindow(windowFromMessages(history as ChatMessage[], cursor, hasMore));
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
        id: crypto.randomUUID(),
        role: "assistant",
        text: `Failed to open session: ${error instanceof Error ? error.message : String(error)}`,
      },
    ];
    setWindow(windowFromMessages(failed, 0, false));
    setLoading(false);
  }
}

function useFileCompletion(
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
    omo.fs
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
  }, [completion?.kind, fileQuery, sessionCwd]);

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
  onAdd: () => Promise<Project | null | undefined>;
  onClear: () => void;
}) {
  const { t } = useI18n();
  const projectItems = projects.map((project) => ({
    label: project.name,
    value: project.cwd,
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
      onValueChange={async (item) => {
        if (!item) {
          return;
        }
        if (item.value === "__new") {
          const project = await onAdd();
          if (project) {
            onSelect(project);
          }
        } else if (item.value === "__none") {
          onClear();
        } else {
          const project = projects.find((entry) => entry.cwd === item.value);
          if (project) {
            onSelect(project);
          }
        }
      }}
      value={items.find((item) => item.value === value) ?? null}
    >
      <SelectTrigger
        className="h-7 min-h-0 w-fit min-w-0 max-w-none justify-start gap-1.5 rounded-md border-0 bg-transparent px-2.5 text-muted-foreground text-xs shadow-none transition-none before:shadow-none hover:bg-accent hover:text-foreground focus-visible:border-transparent focus-visible:ring-0 sm:min-h-0"
        hideIcon
      >
        <Folder className="size-3.5" />
        <SelectValue placeholder={t("choose_project")}>
          {projects.find((project) => project.cwd === value)?.name}
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
  const width = Math.min(
    560,
    Math.max(
      280,
      Math.max(...modelItems.map((item) => item.label.length), 20) * 8 + 72
    )
  );

  return (
    <Select
      items={filtered}
      itemToStringValue={(item) => item.label}
      onValueChange={(item) => item && onChange(item.value)}
      value={selected}
    >
      <SelectTrigger
        className="h-7 min-h-0 w-fit min-w-0 max-w-none justify-start gap-1.5 rounded-md border-0 bg-transparent px-2 text-muted-foreground text-xs shadow-none transition-none before:shadow-none hover:bg-accent hover:text-foreground focus-visible:border-transparent focus-visible:ring-0 sm:min-h-0"
        hideIcon
      >
        <ProviderIcon
          className="size-3.5 shrink-0"
          provider={selected?.provider}
        />
        <SelectValue placeholder={placeholder}>{selected?.label}</SelectValue>
      </SelectTrigger>
      <SelectContent
        alignItemWithTrigger={false}
        className="p-1"
        sideOffset={6}
        style={{ width }}
      >
        <div className="mb-1 flex h-8 items-center gap-2 rounded-md border border-border px-2">
          <Search className="size-3.5 text-muted-foreground" />
          <input
            className="min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground"
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => event.stopPropagation()}
            placeholder="Search models…"
            value={query}
          />
        </div>
        {filteredGroups.map((provider, index) => (
          <SelectGroup key={provider}>
            {index > 0 && <SelectSeparator className="my-1 bg-accent" />}
            <SelectLabel
              className="flex w-full cursor-pointer items-center justify-start gap-1.5 rounded-md px-2 py-1.5 text-left font-medium text-muted-foreground text-sm hover:bg-accent hover:text-foreground"
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
              <ProviderIcon className="size-3.5 shrink-0" provider={provider} />
              {provider}
            </SelectLabel>
            {(expanded.has(provider) || !!query) &&
              filtered
                .filter((item) => item.provider === provider)
                .map((item) => (
                  <SelectItem
                    className="min-h-8 rounded-md pl-7 text-sm"
                    key={`${item.provider}/${item.id}`}
                    value={item}
                  >
                    <span className="flex min-w-0 items-center gap-2">
                      <ProviderIcon
                        className="size-3.5 shrink-0"
                        provider={item.provider}
                      />
                      <span className="truncate">{item.name}</span>
                    </span>
                  </SelectItem>
                ))}
          </SelectGroup>
        ))}
        {filtered.length === 0 && (
          <div className="px-3 py-2 text-muted-foreground text-sm">
            No models found
          </div>
        )}
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
  onChange,
}: {
  items: { value: string; label: string }[];
  value: string;
  placeholder?: string;
  icon?: React.ReactNode;
  disabled?: boolean;
  onChange: (value: string) => void;
}) {
  return (
    <Select
      disabled={disabled}
      items={items}
      itemToStringValue={(item) => item.value}
      onValueChange={(next) => next && onChange(next.value)}
      value={items.find((item) => item.value === value) ?? null}
    >
      <SelectTrigger
        className="h-7 min-h-0 w-fit min-w-0 max-w-none justify-start gap-1.5 rounded-md border-0 bg-transparent px-2 text-muted-foreground text-xs shadow-none transition-none before:shadow-none hover:bg-accent hover:text-foreground focus-visible:border-transparent focus-visible:ring-0 sm:min-h-0"
        hideIcon
      >
        {icon}
        <SelectValue placeholder={placeholder}>
          {items.find((item) => item.value === value)?.label}
        </SelectValue>
      </SelectTrigger>
      <SelectContent
        alignItemWithTrigger={false}
        className="min-w-44 p-1"
        sideOffset={6}
      >
        {items.map((item) => (
          <SelectItem className="text-sm" key={item.value} value={item}>
            {item.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
