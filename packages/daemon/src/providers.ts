import type { Api, Model, Models } from "@earendil-works/pi-ai";

/**
 * Real provider wiring for the daemon (plan §10.1): credentials live in the
 * pi auth store on the EXECUTION side and are never copied into the control
 * database or snapshots (§5.7 凭据只记录引用). `ModelRuntime` owns catalog
 * and OAuth refresh serialization for this process; when Session Workers
 * move to separate OS processes (ADR-006), credential refresh must be
 * re-serialized through a shared broker (§10.1) — do not give each worker
 * its own rotating-token refresher.
 */
export interface ProviderSelection {
  readonly model: Model<Api>;
  readonly models: Models;
}

export const createProviderModels = async (options: {
  readonly authPath?: string;
  readonly modelId: string;
  readonly providerId: string;
}): Promise<ProviderSelection> => {
  const { ModelRuntime } = await import("@earendil-works/pi-coding-agent");
  const models = await ModelRuntime.create({
    authPath: options.authPath,
    refreshOnCreate: false,
  });
  const model = models.getModel(options.providerId, options.modelId);
  if (!model) {
    const available = models
      .getModels(options.providerId)
      .map((candidate) => candidate.id)
      .join(", ");
    throw new Error(
      `model ${options.providerId}/${options.modelId} not found. ` +
        `Available for ${options.providerId}: ${available || "(none — authenticate first)"}`
    );
  }
  return { model, models };
};
