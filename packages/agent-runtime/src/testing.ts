import { createModels, fauxProvider } from "@earendil-works/pi-ai";

/**
 * Test kit: a Models collection wired to the upstream faux provider so P0
 * loops control flow rate, scripted responses and deferred handles without
 * real provider credentials (plan §8.1 workload A, §14 controllable fakes).
 */
export const createFauxModels = (options?: {
  readonly providerId?: string;
  readonly modelId?: string;
}) => {
  const faux = fauxProvider({
    models: [{ id: options?.modelId ?? "faux-1", name: "Faux One" }],
    provider: options?.providerId ?? "faux",
  });
  const models = createModels();
  models.setProvider(faux.provider);
  return {
    faux,
    model: faux.getModel(),
    models,
  };
};
