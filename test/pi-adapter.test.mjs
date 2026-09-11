import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";

register("./alias-hooks.mjs", import.meta.url);

const { adaptPiEvent, adaptPiMessages } = await import(
  "../src/lib/pi-adapter.ts"
);

const errorTexts = (blocks) =>
  blocks.filter((block) => block.type === "error").map((block) => block);

test("omo_error appends a visible error block", () => {
  const blocks = adaptPiEvent([], {
    message: "No API key configured",
    type: "omo_error",
  });
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].type, "error");
  assert.equal(blocks[0].content, "No API key configured");
});

test("auto_retry_start shows a retry notice and updates it in place", () => {
  let blocks = adaptPiEvent([], {
    attempt: 1,
    delayMs: 2000,
    errorMessage: "429 rate limit exceeded",
    maxAttempts: 5,
    type: "auto_retry_start",
  });
  assert.equal(blocks.length, 1);
  assert.deepEqual(blocks[0].retry, {
    attempt: 1,
    delayMs: 2000,
    maxAttempts: 5,
  });

  blocks = adaptPiEvent(blocks, {
    attempt: 2,
    delayMs: 4000,
    errorMessage: "429 rate limit exceeded",
    maxAttempts: 5,
    type: "auto_retry_start",
  });
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].retry.attempt, 2);
});

test("assistant message_start clears the retry notice and trailing errors", () => {
  let blocks = adaptPiEvent([], {
    attempt: 1,
    delayMs: 2000,
    errorMessage: "429 rate limit exceeded",
    maxAttempts: 5,
    type: "auto_retry_start",
  });
  blocks = adaptPiEvent(blocks, {
    message: { role: "assistant" },
    type: "message_start",
  });
  assert.equal(blocks.length, 0);

  // History errors left by a previous failed attempt are superseded too.
  const history = adaptPiMessages([
    { id: "e1", role: "error", text: "429 rate limit exceeded" },
  ]);
  const cleared = adaptPiEvent(history, {
    message: { role: "assistant" },
    type: "message_start",
  });
  assert.equal(cleared.length, 0);
});

test("auto_retry_end success drops the notice without an error", () => {
  let blocks = adaptPiEvent([], {
    attempt: 1,
    delayMs: 2000,
    errorMessage: "429 rate limit exceeded",
    maxAttempts: 5,
    type: "auto_retry_start",
  });
  blocks = adaptPiEvent(blocks, { success: true, type: "auto_retry_end" });
  assert.equal(blocks.length, 0);
});

test("agent_end surfaces the terminal provider error once", () => {
  const agentEnd = {
    messages: [
      { role: "user" },
      {
        errorMessage: "429 rate limit exceeded",
        role: "assistant",
        stopReason: "error",
      },
    ],
    type: "agent_end",
    willRetry: false,
  };
  let blocks = adaptPiEvent([], agentEnd);
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].type, "error");
  assert.equal(blocks[0].content, "429 rate limit exceeded");
  assert.equal(blocks[0].retry, undefined);

  // auto_retry_end with the same final error must not duplicate the block.
  blocks = adaptPiEvent(blocks, {
    finalError: "429 rate limit exceeded",
    success: false,
    type: "auto_retry_end",
  });
  assert.equal(errorTexts(blocks).length, 1);
});

test("agent_end with willRetry keeps blocks untouched", () => {
  const blocks = adaptPiEvent([], {
    messages: [
      {
        errorMessage: "429 rate limit exceeded",
        role: "assistant",
        stopReason: "error",
      },
    ],
    type: "agent_end",
    willRetry: true,
  });
  assert.equal(blocks.length, 0);
});

test("abort during retry backoff leaves no error behind", () => {
  let blocks = adaptPiEvent([], {
    attempt: 1,
    delayMs: 2000,
    errorMessage: "429 rate limit exceeded",
    maxAttempts: 5,
    type: "auto_retry_start",
  });
  blocks = adaptPiEvent(blocks, {
    finalError: "Retry cancelled",
    success: false,
    type: "auto_retry_end",
  });
  assert.equal(blocks.length, 0);
});

test("quota exhaustion without retry renders the final error", () => {
  const blocks = adaptPiEvent([], {
    messages: [
      {
        errorMessage: "insufficient_quota: quota exceeded",
        role: "assistant",
        stopReason: "error",
      },
    ],
    type: "agent_end",
    willRetry: false,
  });
  assert.equal(
    errorTexts(blocks)[0]?.content,
    "insufficient_quota: quota exceeded"
  );
});

test("error messages round-trip through adaptPiMessages", () => {
  const blocks = adaptPiMessages([
    {
      id: "e1",
      retry: { attempt: 2, delayMs: 4000, maxAttempts: 5 },
      role: "error",
      text: "429 rate limit exceeded",
    },
  ]);
  assert.equal(blocks[0].type, "error");
  assert.equal(blocks[0].content, "429 rate limit exceeded");
  assert.deepEqual(blocks[0].retry, {
    attempt: 2,
    delayMs: 4000,
    maxAttempts: 5,
  });
});

test("message_end surfaces the failed attempt immediately", () => {
  const blocks = adaptPiEvent([], {
    message: {
      errorMessage: "insufficient_quota: quota exceeded",
      role: "assistant",
      stopReason: "error",
    },
    type: "message_end",
  });
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].type, "error");
  assert.equal(blocks[0].content, "insufficient_quota: quota exceeded");
});

test("auto_retry_start folds the failed attempt into a retry notice", () => {
  let blocks = adaptPiEvent([], {
    message: {
      errorMessage: "429 rate limit exceeded",
      role: "assistant",
      stopReason: "error",
    },
    type: "message_end",
  });
  blocks = adaptPiEvent(blocks, {
    attempt: 1,
    delayMs: 2000,
    errorMessage: "429 rate limit exceeded",
    maxAttempts: 5,
    type: "auto_retry_start",
  });
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].retry?.attempt, 1);
});

test("agent_end ignores errors of earlier turns when the run recovered", () => {
  // Turn 1 failed and already reported its error via message_end; the queued
  // follow-up (turn 2) then succeeded. The trailing error of turn 1 must not
  // leak into turn 2, and agent_end must not re-report it.
  let blocks = adaptPiEvent([], {
    message: {
      errorMessage: "429 rate limit exceeded",
      role: "assistant",
      stopReason: "error",
    },
    type: "message_end",
  });
  blocks = adaptPiEvent(blocks, {
    messages: [
      { role: "user" },
      {
        errorMessage: "429 rate limit exceeded",
        role: "assistant",
        stopReason: "error",
      },
      { role: "user" },
      { role: "assistant", stopReason: "stop" },
    ],
    type: "agent_end",
    willRetry: false,
  });
  assert.equal(errorTexts(blocks).length, 1);
});

test("agent_end reports a terminal error missed by message_end", () => {
  const blocks = adaptPiEvent([], {
    messages: [
      { role: "user" },
      {
        errorMessage: "429 rate limit exceeded",
        role: "assistant",
        stopReason: "error",
      },
    ],
    type: "agent_end",
    willRetry: false,
  });
  assert.equal(errorTexts(blocks)[0]?.content, "429 rate limit exceeded");
});
