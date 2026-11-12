import { defineExtension, defineTool } from "@earendil-works/pi-durable";
import { num, obj, opt, str } from "@earendil-works/pi-schema";
import { hostFs } from "./host";

const asText = (text: string) => [{ type: "text" as const, text }];

const listDirectory = defineTool({
  name: "list_directory",
  description:
    "List the entries of a directory inside the workspace. Paths are relative to the workspace root; use \".\" for the root.",
  parameters: obj({ path: opt(str()) }),
  execute: async (args: any) => {
    const out = hostFs("list", { path: args.path ?? "." });
    return { output: asText(out.text), details: { count: out.count } };
  },
});

const readFile = defineTool({
  name: "read_file",
  description:
    "Read a UTF-8 text file inside the workspace. Paths are relative to the workspace root. Large files are truncated and say so.",
  parameters: obj({ path: str(), start_line: opt(num()), end_line: opt(num()) }),
  execute: async (args: any) => {
    const out = hostFs("read", {
      path: args.path,
      start_line: args.start_line,
      end_line: args.end_line,
    });
    return { output: asText(out.text), details: { bytes: out.bytes, truncated: !!out.truncated } };
  },
});

const writeFile = defineTool({
  name: "write_file",
  description:
    "Create or overwrite a UTF-8 text file inside the workspace. Parent directories are created. Paths are relative to the workspace root.",
  parameters: obj({ path: str(), content: str() }),
  execute: async (args: any) => {
    const out = hostFs("write", { path: args.path, content: args.content });
    return { output: asText(`Wrote ${out.bytes} bytes to ${out.path}`), details: { path: out.path, bytes: out.bytes } };
  },
});

const searchFiles = defineTool({
  name: "search_files",
  description:
    "Search file names and text contents below a workspace directory. Returns matching paths with line numbers. Paths are relative to the workspace root.",
  parameters: obj({ query: str(), path: opt(str()), max_results: opt(num()) }),
  execute: async (args: any) => {
    const out = hostFs("search", {
      query: args.query,
      path: args.path ?? ".",
      max_results: args.max_results ?? 40,
    });
    return { output: asText(out.text), details: { matches: out.matches, truncated: !!out.truncated } };
  },
});

export const workspaceExtension = defineExtension({
  name: "workspace",
  tools: [listDirectory, readFile, writeFile, searchFiles],
});

export const SYSTEM_INSTRUCTIONS = `You are omo, a coding assistant running in a native desktop app.

You can inspect and modify the user's workspace with the workspace tools:
- list_directory(path)
- read_file(path, start_line?, end_line?)
- write_file(path, content)
- search_files(query, path?, max_results?)

All paths are relative to the workspace root. The tools enforce that every path stays inside the workspace; attempts to
escape it fail. Do not invent file contents: read before you edit, and when you write a file say which path you wrote.
Prefer small, focused changes and explain them briefly.`;
