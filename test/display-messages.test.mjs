import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";

const require = createRequire(import.meta.url);
const { displayMessages } = require("../server/display-messages.cjs");

const user = (text, timestamp = 1) => ({
  content: [{ text, type: "text" }],
  role: "user",
  timestamp,
});

const assistantError = (errorMessage, timestamp = 2) => ({
  content: [],
  errorMessage,
  role: "assistant",
  stopReason: "error",
  timestamp,
});

const assistantText = (text, timestamp = 3) => ({
  content: [{ text, type: "text" }],
  role: "assistant",
  stopReason: "stop",
  timestamp,
});

const errorItems = (items) => items.filter((item) => item.role === "error");

test("a failed assistant call renders an error item", () => {
  const items = displayMessages([
    user("hi"),
    assistantError("429 rate limit exceeded"),
  ]);
  const errors = errorItems(items);
  assert.equal(errors.length, 1);
  assert.equal(errors[0].text, "429 rate limit exceeded");
});

test("retried-then-recovered attempts drop the transient errors", () => {
  const items = displayMessages([
    user("hi"),
    assistantError("429 rate limit exceeded", 2),
    assistantError("429 rate limit exceeded", 4),
    assistantText("done", 6),
  ]);
  assert.equal(errorItems(items).length, 0);
  assert.equal(items.at(-1).text, "done");
});

test("a turn that ends in repeated failures keeps only the final error", () => {
  const items = displayMessages([
    user("hi"),
    assistantError("429 rate limit exceeded", 2),
    assistantError("429 rate limit exceeded", 4),
  ]);
  const errors = errorItems(items);
  assert.equal(errors.length, 1);
});

test("errors from earlier turns survive a later successful turn", () => {
  const items = displayMessages([
    user("first", 1),
    assistantError("insufficient_quota: quota exceeded", 2),
    user("second", 3),
    assistantText("ok", 4),
  ]);
  const errors = errorItems(items);
  assert.equal(errors.length, 1);
  assert.equal(errors[0].text, "insufficient_quota: quota exceeded");
});

test("partial assistant text is kept alongside the error", () => {
  const items = displayMessages([
    user("hi"),
    {
      content: [{ text: "partial answer", type: "text" }],
      errorMessage: "stream ended without message_stop",
      role: "assistant",
      stopReason: "error",
      timestamp: 2,
    },
  ]);
  const texts = items.map((item) => `${item.role}:${item.text}`);
  assert.deepEqual(texts, [
    "user:hi",
    "assistant:partial answer",
    "error:stream ended without message_stop",
  ]);
});

test("aborted assistant messages produce no error item", () => {
  const items = displayMessages([
    user("hi"),
    { content: [], role: "assistant", stopReason: "aborted", timestamp: 2 },
  ]);
  assert.equal(errorItems(items).length, 0);
});
