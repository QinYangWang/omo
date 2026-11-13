# omo bots design (DS Bot parity)

Target: the same product shape as DS Bot — a persistent team of named Bots with
private chats, group chats, bot-to-bot handoffs, memory, skills, permissions,
approvals and channels — implemented on omo's stack (Go host, moejs,
pi-durable, MyGo widgets, SQLite/JSONL). Nothing here requires Node, a browser
engine, or an execution model we do not have.

The work-item/auto-merge layer (phase 7 below) is a later phase on top of this;
the Bot team is the base.

## 1. How DS Bot does it, and what we do instead

| Capability | DS Bot | omo |
| --- | --- | --- |
| Bot identity | one DSH root Session per Bot; roster in `bot/state.json` | one durable pi-durable conversation per Bot; roster in `bots/state.json` (`internal/bots`) |
| Message history | append-only JSONL ledgers (`group-*.jsonl`, `pair-*-*.jsonl`); every reader reads them | same: `bots/ledger/*.jsonl`, single write path |
| Group chat | one group Session; members answer in their own Bot Session | one durable group conversation; members run in their Bot conversation, group ledger keeps the transcript |
| Group round control | one speaker at a time for discussion; parallel only for dispatched work; a round runs outside the group Session | pi-durable run per member, orchestrated by the Go host from the ledger |
| Bot-to-bot handoff | work tree with results propagating up; unread merged per sender; `request_id` idempotency | pi-durable task graph (`waiting`/`on`/`failFast`) plus the ledger's `request_id` dedupe |
| Turn/status tracking | `turns.js`: what each Bot is doing, waiters, inboxes | engine events (`turn`/`bot`) + state docs; one status per Bot |
| Memory | per-Bot memory, group memory, Main Bot can read/curate | pi-durable conversation documents per Bot/group + a memory skill |
| Permissions | per-Bot preset (read-only / workspace / full) + working folder | per-Bot preset enforced in `internal/host` and the execution env |
| Approvals | cards in chat; Main Bot rights checks | approval records + host action queue; same UI pattern later |
| Skills/capabilities | team list of MCP servers, skills, packs; additive per Bot | skills already discovered and injected; MCP later |
| Schedules | scheduled prompts per Bot/group | durable `sleepUntil` + host `onWake` |
| Channels | IM bridges (WeChat/Feishu/Telegram/…), GitHub connector | `plugin` adapters; GitHub issues first |
| Browser / computer use | per-Bot browser, desktop control | explicitly out of scope for now (no WebView, no remote input) |
| Local agent CLIs as Bots | wraps Claude Code/Codex/… | not planned; pi-durable is the only runtime |

Non-negotiable differences:

- We do not fork or re-plumb pi-durable. Its task graph and durable submissions
  replace DS Bot's hand-written work tree, unread caps and relay bookkeeping.
- We never keep a second copy of a message. If a reader needs a summary, it
  derives it from the ledger.
- Prompt prefixes stay byte-stable: Bot status, group roster and current time
  are tool-visible state, never system-prompt text.

## 2. Data model (`internal/bots`, phase 1 done)

```
<data>/bots/state.json          roster, groups, read cursors
<data>/bots/ledger/
  pair-<id>-<id>.jsonl          one Bot pair, ids sorted
  group-<id>.jsonl              one group
```

`state.json`:

```jsonc
{
  "version": 1,
  "bots":   [{ "id": "b…", "name": "Chief", "role": "main|member",
               "model": "deepseek-chat", "thinking": "high",
               "folder": "D:/work/app", "permission": "workspace|read-only|full",
               "private": false, "createdAt": 1794… }],
  "groups": [{ "id": "g…", "name": "Build", "adminId": "b…",
               "members": ["b…"], "folder": "", "permission": "workspace",
               "notice": "", "createdAt": 1794… }],
  "cursors": { "pair-<a>-<b>|<botId>": 42 }
}
```

Ledger record:

```jsonc
{ "seq": 1, "id": "m…", "at": 1794…, "kind": "message|notice",
  "from": "b…", "to": "b…", "text": "…",
  "requestId": "work-1", "fingerprint": "<sha256>" }
```

Rules implemented in `internal/bots/store.go`:

- `seq` is per scope, assigned by the only writer, never reused; replay skips a
  torn last line instead of failing.
- `SendMessage(from, to, text, requestID)`: same sender + scope + request id +
  same text returns the original record (`duplicate=true`); different text with
  the same id is an error. Without a request id it is a plain append.
- `Inbox(bot)` merges every unread message from one sender in one scope into a
  single item (text joined, seqs listed), so an inbox cannot become a backlog.
- `MarkRead` moves a per-scope cursor and persists it.
- Deleting a Bot removes it from the roster, groups and cursors; its history
  stays readable.

## 3. Sessions and turns

- **Bot conversation**: one durable conversation per Bot, holding its private
  chat, memory, and the work it did for others. Bot ID is the stable key.
- **Group conversation**: one durable conversation per group, holding the
  group's transcript, notice and shared memory. Members do not run here.
- **A dispatched task** is a pi-durable child task owned by the caller's turn;
  the child runs in the target Bot's conversation, and the caller's turn waits
  on it (`waiting` + `on`). Result propagation is the task outcome, not a
  second message.
- **A group round**: the host writes the user message to the group ledger, picks
  who answers (admin first, or `@`), starts one run per picked member
  concurrently for dispatched work, and serializes ordinary discussion. The
  round is a host-owned task; the group conversation is not blocked by it.
- **Status** per Bot is derived: `working`, `waiting_approval`, `waiting_bot`,
  `idle`, exposed through a `list_bots` tool and one engine event. It is never
  put in a system prompt.

## 4. Tools (registered in every Bot conversation)

| Tool | Behavior |
| --- | --- |
| `message_bot(to, text, request_id?, when?)` | append to the pair ledger, deliver as a turn to the target Bot; returns the target's status; idempotent by `request_id` |
| `list_bots()` | roster with each Bot's status, unread count, model and folder |
| `post_to_group(group, text, @names)` | only for its own groups (Main Bot: any); picks who answers |
| `read_group_chat(group, from_seq?, limit?)` | reads the group ledger |
| `create_bot` / `update_bot` / `create_group` / `update_group` | Main Bot only |
| `ask_user(question, options?)` | question card; blocks the turn until answered |
| `use_skill(name)` | existing skill loader, counted in telemetry |

`message_bot` and `post_to_group` never carry the only copy of a decision: the
ledger and the work item are the record.

## 5. Group rules (copied from DS Bot because they were learned the hard way)

- Default mode: admin answers first and calls members in; `@name` addresses a
  member directly; no admin means round-robin.
- Ordinary discussion is serialized: one speaker at a time, each sees the
  previous message. Dispatched work is parallel: everyone named in one message
  starts at once and does not see the others' in-flight answers.
- A batch wakes the dispatcher once, when the last member lands.
- Long work releases the speaking slot: after the first tool call, keep going
  in the background and post progress; the round does not wait forever.
- Members may `[PASS]`. A member that only says "on it" without a tool call is
  pushed once to actually work.
- Stop: one group-wide stop cancels this round and every member's work started
  by it; other conversations are untouched.
- Work has one place: a task dispatched in a group stays in that group; using a
  private message for the same task is rejected.

## 6. Permissions, folders, approvals, secrets

- Permission preset per Bot; folder per Bot, overridable per group. A Bot may not
  target the app data or team data directories, and a folder change is a new
  conversation segment.
- Work folder of a turn, first set wins: group folder, the member's folder in
  that group, the Bot's folder, then the team workspace. The app has the Bot's
  folder and the team workspace today; the group layers arrive with groups
  (phase 4). Picking a folder in the native picker is the approval, and omo's
  data folder and its parents are refused. A folder change moves no history:
  the next turn runs in the new folder.
- Attachments: files picked from anywhere are copied into
  `<Bot folder>/.omo/uploads/<bot>/` and listed in the message, so the
  workspace tools can read them. Only UTF-8 text is readable today.
- Host file access is enforced in `internal/host` (the existing workspace guard)
  extended to the Bot's folder; a command sandbox comes with the execution env.
- Approvals: a turn can stop on a request; the request is a record, not a chat
  message, so the UI can list all pending requests. Rules compose as "ask first
  wins": team rules can only make a Bot stricter.
- Secrets stay in `credentials.json`; tools receive `$OMO_SECRET_<NAME>`
  references, and tool output and outbound requests are redacted. Bots never
  see raw keys.

## 7. Memory and learning

- Bot memory: one document per Bot (preferences, durable facts) plus a compact
  conversation summary. Main Bot may read and propose edits; only the owner Bot
  or the user writes its memory.
- Group memory: one document per group, visible to its members, not to bots
  outside the group.
- Memory is written in explicit commits, never by dumping transcript text.
- Skills: file-based today; recording a demonstrated workflow into a skill is a
  later phase, behind user confirmation.

## 8. Channels and adapters

- `plugin` owns adapters as host code behind explicit permissions.
- First adapter: GitHub issues (polling with ETag/cursor, no public webhook),
  mapping issues to work for a Bot, and posting status/PR links back.
- IM adapters (WeChat/Feishu/Telegram/…) later; the ledger is the delivery
  point, so an adapter only reads and appends.

## 9. Phases

| Phase | Scope | State |
| --- | --- | --- |
| 0 | This document; subsystem registry | done |
| 1 | `internal/bots`: roster, groups, ledger, idempotent sends, merged inbox, cursors | **done + tested** |
| 2 | Bot sessions: open the team, one conversation per Bot, `sendToBot`, status snapshots, per-Bot history restored on reopen | **done + tested** |
| 2b | One durable database per team; chat session store removed; UI rail shows Bots | **done** |
| 3 | Bot-to-bot: `message_bot`/`list_bots`, delivery as a turn, handoff as a pi-durable child task, batch wake | |
| 4 | Groups: admin-first, `@`, parallel dispatch, one-speaker discussion, `post_to_group`/`read_group_chat`, stop | |
| 5 | Permissions/folders/approvals/secrets enforcement in the host; question cards | |
| 6 | Memory documents, schedules (`sleepUntil`/`onWake`), skills/capabilities manager | |
| 7 | GitHub issues adapter, work items and acceptance checks, auto-merge | |
| 8 | Default widget compositions (roster, chat, group, activity) — UI work, needs sign-off | |

## 10. Not doing

- Browser control, computer use, remote mobile/IM servers, office document
  rendering: no WebView and no remote input in this product.
- Local CLI agents as Bots.
- A second message store, a second fact log, or quota-based anti-loop limits.
