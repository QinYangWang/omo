# core data

Owner: `core` (`internal/app`, `internal/bots`, `internal/config`, `internal/host`).

Two stores live in the core:

- `bots/` — the team: roster, groups, and the append-only message ledger
  (`internal/bots`). The only writer of messages. Layout and rules are in
  `docs/bots/design.md`.
- `settings.json` / `credentials.json` — configuration and per-provider keys.

The old per-chat `sessions/` store and its `app.db` mirror were removed when the
team replaced the chat session model: a Bot's history is its durable
conversation in `teams/<teamId>/durable.db`, not a mirrored table. Numeric
activity lives in `telemetry.db` (`docs/telemetry/agent-activity.md`).

## Team identity

`teamId = "t" + hex(sha256(lower(workspaceRoot))[:6])`. It names the durable
database (`<data>/teams/<teamId>/durable.db`) and the telemetry `session_id`.
Changing the workspace opens a different team; the old one stays on disk.

## Roster to runtime

`App.openTeam()` hands the runtime one `TeamBot` per roster entry, including the
`conversationId` stored on the Bot. The first time a Bot is opened the runtime
creates its conversation and reports it with a `bot_session` event;
`bots.Store.SetBotConversation` persists it so a reopen reuses the same history.

`App.teamSignature()` (bot ids + conversation ids) decides whether the runtime
must be reopened — after adding a Bot, or after a conversation was created.

## Work folders

A turn's tools run in one folder, resolved by `App.BotFolder`:

```text
group folder > member folder in that group > the Bot's folder > team workspace
```

The app has the Bot's folder (`bots.Bot.Folder`, set from the Details panel) and
the team workspace; the group layers come with groups. `App.Send` scopes the
engine to that folder before dispatching the turn, so tool paths are relative to
it. `SetBotFolder` refuses omo's data folder and its parents and never moves
files: the next turn simply runs in the new folder.

## Attachments

`App.AttachFiles` copies picked files (from anywhere) to
`<Bot folder>/.omo/uploads/<bot>/`, one name per file with a `-2` suffix on a
collision. `App.Send` appends the workspace-relative paths to the message, so
`read_file` and `search_files` can reach them. The copy is capped at 32 MB and
only UTF-8 text is readable by the tools.

## Skills (`internal/app/skills.go`)

Discovery order, first name wins:

```text
<omo data dir>/skills/**/SKILL.md
<workspace>/.omo/skills/**/SKILL.md
<workspace>/.pi/skills/**/SKILL.md
```

A directory containing `SKILL.md` is a skill root and is not searched further;
directories are walked at most 4 levels deep and dot directories are skipped.
The frontmatter must be flat `key: value` lines with `name` and `description`.
A skill without a description is skipped; a skill without a name uses its
directory name. Files are capped at 64 KiB. The host sends the whole content;
the runtime never reads skill files.
