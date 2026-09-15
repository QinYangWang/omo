import {
  type AgentEventEnvelope,
  type HostHealth,
  HostHealthSchema,
  parseContract,
} from "@omo/contracts";

export interface HostRegistration {
  credentialId?: string;
  hostId?: string;
  label: string;
  registryId: string;
  url: string;
}

export interface HostRegistryPort {
  load: () => Promise<HostRegistration[]>;
  save: (hosts: readonly HostRegistration[]) => Promise<void>;
}

export type CreateRegistryId = () => string;

const TRAILING_SLASHES_PATTERN = /\/+$/;
const TRAILING_SLASH_PATTERN = /\/$/;

const normalizeHostUrl = (url: string): string => {
  const parsed = new URL(url);
  if (!["http:", "https:"].includes(parsed.protocol)) {
    throw new Error("Host URL must use HTTP or HTTPS");
  }
  if (parsed.username || parsed.password) {
    throw new Error("Host URL must not contain credentials");
  }
  parsed.hash = "";
  parsed.pathname = parsed.pathname.replace(TRAILING_SLASHES_PATTERN, "");
  parsed.search = "";
  return parsed.toString().replace(TRAILING_SLASH_PATTERN, "");
};

export class HostRegistry {
  readonly #createId: CreateRegistryId;
  readonly #port: HostRegistryPort;
  #hosts: HostRegistration[] = [];

  constructor(port: HostRegistryPort, createId: CreateRegistryId) {
    this.#port = port;
    this.#createId = createId;
  }

  async initialize(): Promise<readonly HostRegistration[]> {
    this.#hosts = await this.#port.load();
    return this.list();
  }

  list(): readonly HostRegistration[] {
    return this.#hosts;
  }

  findByHostId(hostId: string): HostRegistration | undefined {
    return this.#hosts.find((host) => host.hostId === hostId);
  }

  async register(input: {
    credentialId?: string;
    label?: string;
    url: string;
  }): Promise<HostRegistration> {
    const url = normalizeHostUrl(input.url);
    const existing = this.#hosts.find((candidate) => candidate.url === url);
    if (existing) {
      return existing;
    }
    const host = {
      credentialId: input.credentialId,
      label: input.label?.trim() || new URL(url).host,
      registryId: this.#createId(),
      url,
    };
    await this.replace([...this.#hosts, host]);
    return host;
  }

  async confirmIdentity(
    registryId: string,
    health: HostHealth
  ): Promise<HostRegistration> {
    const current = this.#hosts.find((host) => host.registryId === registryId);
    if (!current) {
      throw new Error(`Unknown Host registration: ${registryId}`);
    }
    const duplicate = this.#hosts.find(
      (host) => host.registryId !== registryId && host.hostId === health.hostId
    );
    if (duplicate) {
      throw new Error(
        `Host identity ${health.hostId} is already registered as ${duplicate.registryId}`
      );
    }
    const identified = { ...current, hostId: health.hostId };
    await this.replace(
      this.#hosts.map((host) =>
        host.registryId === registryId ? identified : host
      )
    );
    return identified;
  }

  async remove(registryId: string): Promise<boolean> {
    const hosts = this.#hosts.filter((host) => host.registryId !== registryId);
    if (hosts.length === this.#hosts.length) {
      return false;
    }
    await this.replace(hosts);
    return true;
  }

  private async replace(hosts: HostRegistration[]): Promise<void> {
    await this.#port.save(hosts);
    this.#hosts = hosts;
  }
}

export interface HostProbePort {
  health: (host: HostRegistration) => Promise<unknown>;
}

export type ConnectionStatus =
  | { readonly state: "idle" }
  | { readonly state: "connecting" }
  | { readonly health: HostHealth; readonly state: "online" }
  | { readonly error: string; readonly state: "offline" };

export class HostConnection {
  readonly #host: HostRegistration;
  readonly #probe: HostProbePort;
  #attempt = 0;
  #status: ConnectionStatus = { state: "idle" };

  constructor(host: HostRegistration, probe: HostProbePort) {
    this.#host = host;
    this.#probe = probe;
  }

  get status(): ConnectionStatus {
    return this.#status;
  }

  async connect(): Promise<ConnectionStatus> {
    const attempt = this.#attempt + 1;
    this.#attempt = attempt;
    this.#status = { state: "connecting" };
    try {
      const health = parseContract(
        HostHealthSchema,
        await this.#probe.health(this.#host),
        "HostHealth"
      );
      if (attempt === this.#attempt) {
        this.#status = { health, state: "online" };
      }
    } catch (error) {
      if (attempt === this.#attempt) {
        this.#status = {
          error: error instanceof Error ? error.message : String(error),
          state: "offline",
        };
      }
    }
    return this.#status;
  }

  disconnect(): void {
    this.#attempt += 1;
    this.#status = { state: "idle" };
  }
}

export type AttachmentStatus =
  | "detached"
  | "connecting"
  | "live"
  | "snapshot-required";

export type EventAcceptance = "accepted" | "duplicate" | "gap";

export class SessionAttachmentState {
  readonly sessionId: string;
  #sequence: number;
  #status: AttachmentStatus = "detached";

  constructor(sessionId: string, afterSequence = 0) {
    if (!Number.isSafeInteger(afterSequence) || afterSequence < 0) {
      throw new Error("Event sequence must be a non-negative safe integer");
    }
    this.sessionId = sessionId;
    this.#sequence = afterSequence;
  }

  get afterSequence(): number {
    return this.#sequence;
  }

  get status(): AttachmentStatus {
    return this.#status;
  }

  connecting(): void {
    this.#status = "connecting";
  }

  connected(): void {
    if (this.#status !== "snapshot-required") {
      this.#status = "live";
    }
  }

  disconnected(): void {
    if (this.#status !== "snapshot-required") {
      this.#status = "detached";
    }
  }

  accept(event: AgentEventEnvelope): EventAcceptance {
    if (event.sessionId !== this.sessionId) {
      throw new Error(
        `Received Session ${event.sessionId} event for ${this.sessionId}`
      );
    }
    if (event.sequence <= this.#sequence) {
      return "duplicate";
    }
    if (event.sequence !== this.#sequence + 1) {
      this.#status = "snapshot-required";
      return "gap";
    }
    this.#sequence = event.sequence;
    this.#status = "live";
    return "accepted";
  }

  hydrate(sequence: number): void {
    if (!Number.isSafeInteger(sequence) || sequence < 0) {
      throw new Error("Snapshot sequence must be a non-negative safe integer");
    }
    this.#sequence = sequence;
    this.#status = "live";
  }
}
