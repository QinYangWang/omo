import { appendFileSync, renameSync, statSync } from "node:fs";
import type {
  AttributeValue,
  SpanOptions,
  SpanStatus,
  TelemetryContext,
  TelemetrySpan,
} from "@earendil-works/pi-telemetry";

/**
 * omo telemetry sink (plan §10.3): a bounded local NDJSON log implementing
 * the pi-telemetry `TelemetryContext` contract.
 *
 * Rules honoured here:
 *  - diagnostics NEVER break business paths: every write failure is
 *    swallowed, and rotation drops old data instead of growing without bound
 *    (the antipattern called out for `InMemoryTelemetryContext` in §10.3);
 *  - no prompt bodies, thinking content, tool arguments or secrets are
 *    recorded — callers pass low-cardinality attributes plus trace ids only;
 *  - IDs may correlate traces (§10.3) but stay out of any future metrics
 *    label path.
 *
 * Rotation: when the active file exceeds `maxBytes`, it is renamed to
 * `<file>.old` (replacing any previous generation) and a fresh file starts.
 */

interface SpanRecord {
  readonly attributes: Record<string, AttributeValue>;
  readonly durationMs: number;
  readonly endedAt: string;
  readonly events: readonly {
    readonly attributes?: Record<string, AttributeValue>;
    readonly name: string;
  }[];
  readonly name: string;
  readonly status: SpanStatus;
}

export class NdjsonTelemetry implements TelemetryContext {
  readonly #filePath: string;
  readonly #maxBytes: number;

  constructor(options: { filePath: string; maxBytes?: number }) {
    this.#filePath = options.filePath;
    this.#maxBytes = options.maxBytes ?? 16_777_216;
  }

  async startSpan<T>(
    options: SpanOptions,
    callback: (span: TelemetrySpan) => T | Promise<T>
  ): Promise<T> {
    const startedAt = Date.now();
    const events: SpanRecord["events"][number][] = [];
    const attributes: Record<string, AttributeValue> = {
      ...(options.attributes as Record<string, AttributeValue> | undefined),
    };
    let status: SpanStatus = { status: "ok" };
    const span: TelemetrySpan = {
      addEvent: (name, eventAttributes) => {
        events.push({
          attributes: eventAttributes as Record<string, AttributeValue>,
          name,
        });
      },
      setAttributes: (next) => {
        Object.assign(attributes, next);
      },
      setStatus: (next) => {
        status = next;
      },
      startSpan: (childOptions, childCallback) =>
        this.startSpan(childOptions, childCallback),
    };
    try {
      return await callback(span);
    } finally {
      this.#write({
        attributes,
        durationMs: Date.now() - startedAt,
        endedAt: new Date().toISOString(),
        events,
        name: options.name,
        status,
      });
    }
  }

  #write(record: SpanRecord): void {
    try {
      const { size } = statSync(this.#filePath);
      if (size > this.#maxBytes) {
        renameSync(this.#filePath, `${this.#filePath}.old`);
      }
    } catch {
      // Missing file is the normal cold start; other stat failures drop data.
    }
    try {
      appendFileSync(this.#filePath, `${JSON.stringify(record)}\n`);
    } catch {
      // Drop diagnostics, never the business operation (§10.3).
    }
  }
}
