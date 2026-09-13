/**
 * P0 durability experiment — daemon child process hosting the command inbox.
 *
 * Protocol (parent ↔ child over IPC):
 *   { type: "receive", command }      → child runs inbox.receive, then replies
 *                                       { type: "receipt", receipt }
 *   { type: "receiveAndDie", command }→ child commits the receive, then
 *                                       SIGKILLs itself WITHOUT replying
 *                                       (crash inside the reply window)
 *   { type: "dump" }                  → { type: "dump", records } durable rows
 *
 * The child never keeps authoritative state in memory: everything goes
 * through CommandInbox on a WAL + FULL database.
 */
import { CommandInbox } from "@omo/control-plane/inbox";

const principal = {
  deviceId: "dev_receipt_tester",
  userId: "usr_receipt_tester",
};
const [inboxPath] = process.argv.slice(2);
if (!inboxPath) {
  throw new Error("usage: inbox-daemon.mjs <inbox-db-path>");
}
const inbox = CommandInbox.open(inboxPath);

process.on("message", (message) => {
  if (!message || typeof message !== "object") {
    return;
  }
  if (message.type === "receive" || message.type === "receiveAndDie") {
    const { command } = message;
    const receipt = inbox.receive(
      {
        clientMutationId: command.clientMutationId,
        commandId: command.commandId,
        kind: command.kind,
        operationId: command.operationId,
        payload: command.payload,
        scope: command.scope,
      },
      principal
    );
    if (message.type === "receiveAndDie") {
      // Commit already happened inside receive(); die before the reply.
      process.kill(process.pid, "SIGKILL");
      return;
    }
    process.send?.({ receipt, type: "receipt" });
    return;
  }
  if (message.type === "dump") {
    const records = inbox
      .listByScope(message.scope)
      .map(({ commandId, inboxSeq, kind, payloadHash, state }) => ({
        commandId,
        inboxSeq,
        kind,
        payloadHash,
        state,
      }));
    process.send?.({ records, type: "dump" });
  }
});
process.send?.({ type: "ready" });
