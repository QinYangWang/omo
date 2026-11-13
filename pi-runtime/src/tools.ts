import { defineExtension, defineTool } from "@earendil-works/pi-durable";
import { bool, num, obj, opt, str } from "@earendil-works/pi-schema";
import { hostFs } from "./host";
import { hitSkill } from "./metrics";
import { skillForPath } from "./skills";

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
    "Read a UTF-8 text file inside the workspace. Paths are relative to the workspace root. Large files are truncated and say so; pass start_line and end_line to read a range.",
  parameters: obj({ path: str(), start_line: opt(num()), end_line: opt(num()) }),
  execute: async (args: any, api: any) => {
    const out = hostFs("read", {
      path: args.path,
      start_line: args.start_line,
      end_line: args.end_line,
    });
    const skill = skillForPath(args.path);
    if (skill) hitSkill(api.conversationId, skill.name);
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

const editFile = defineTool({
  name: "edit_file",
  description:
    "Replace an exact text snippet in a workspace file. old_text must match the file byte for byte (including indentation) and occur exactly once unless replace_all is true. Read the file first.",
  parameters: obj({ path: str(), old_text: str(), new_text: str(), replace_all: opt(bool()) }),
  execute: async (args: any) => {
    const current = hostFs("read", { path: args.path });
    const text = String(current?.text ?? "");
    const needle = String(args.old_text ?? "");
    const replacement = String(args.new_text ?? "");
    if (!needle) throw new Error("old_text must not be empty");
    const parts = text.split(needle);
    const found = parts.length - 1;
    if (found === 0) throw new Error(`old_text was not found in ${args.path}; read the file and copy the exact snippet`);
    if (found > 1 && !args.replace_all) {
      throw new Error(`old_text occurs ${found} times in ${args.path}; pass a longer snippet or set replace_all`);
    }
    const next = parts.join(replacement);
    const out = hostFs("write", { path: args.path, content: next });
    return {
      output: asText(`Replaced ${args.replace_all ? found : 1} occurrence(s) in ${out.path}`),
      details: { path: out.path, occurrences: args.replace_all ? found : 1, bytes: out.bytes },
    };
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
  tools: [listDirectory, readFile, writeFile, editFile, searchFiles],
});

export const SYSTEM_INSTRUCTIONS = `You are omo, a coding assistant running in a native Windows desktop app. You work directly in the user's workspace.

Tools:
- list_directory(path)
- read_file(path, start_line?, end_line?)
- write_file(path, content)
- edit_file(path, old_text, new_text, replace_all?)
- search_files(query, path?, max_results?)
- use_skill(name) loads a skill's instructions when a task matches one
- subagent(agents) delegates work to child agents, optionally with dependencies

Working rules:
- All paths are relative to the workspace root. Tools reject paths that leave it.
- Read a file before editing it. Never invent file contents.
- Change files with edit_file for targeted edits and write_file for new files or full rewrites.
- Prefer small, focused changes that follow the conventions already in the code. Look at neighbouring code first.
- You cannot run shell commands: verify by reading the files you changed and the tests or build files around them, and say what still needs a run.
- When a request is large or independent pieces can run in parallel, delegate with subagent instead of doing everything yourself.
- Answer in the user's language and keep the reply short: what you changed, where, and what remains.`;
