import { createRemoteApi, getRemoteConfig } from "@/lib/remote-api"
import { installWebPreviewApi } from "@/lib/web-preview"

let cachedRemote: { key: string; api: OmoApi } | undefined

export function getOmoApi(): OmoApi {
  const remote = getRemoteConfig()
  if (remote.url) {
    const key = `${remote.url}\n${remote.token}`
    if (cachedRemote?.key !== key) cachedRemote = { key, api: createRemoteApi(remote.url, remote.token) }
    return cachedRemote.api
  }
  if (!window.omo) installWebPreviewApi()
  return window.omo
}

export const omo = new Proxy({} as OmoApi, {
  get(_target, property) {
    return getOmoApi()[property as keyof OmoApi]
  },
})
