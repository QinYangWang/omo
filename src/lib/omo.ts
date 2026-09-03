import { getServerApi } from "@/lib/servers";

/** API of the default server (local when available, otherwise the first remote). */
export const omo = new Proxy({} as omoApi, {
  get(_target, property) {
    return getServerApi()[property as keyof omoApi];
  },
});
