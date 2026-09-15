"use strict";

const { randomUUID } = require("node:crypto");

const BROWSER_PROXY_PREFIX = "/api/v1/browser";
const BROWSER_SESSION_IDLE_MS = 30 * 60_000;
const BROWSER_REQUEST_TIMEOUT_MS = 30_000;
const MAX_BROWSER_REQUEST_BODY_BYTES = 16 * 1024 * 1024;
const MAX_BROWSER_RESPONSE_BYTES = 32 * 1024 * 1024;
const MAX_BROWSER_URL_LENGTH = 8192;
const MAX_BROWSER_COOKIES = 300;
const MAX_BROWSER_SESSIONS = 100;
const browserUrlPattern = /^https?:$/i;
const browserProxyPattern = /^\/api\/v1\/browser\/([^/]+)\/proxy$/;
const browserSessionPattern = /^\/api\/v1\/browser\/([^/]+)$/;
const browserNavigatePattern = /^\/api\/v1\/browser\/([^/]+)\/navigate$/;
const htmlContentPattern = /(?:text\/html|application\/xhtml\+xml)/i;
const cssContentPattern = /text\/css/i;
const urlAttributePattern =
  /(\s(?:href|src|action|formaction|poster|cite|background|longdesc|manifest)\s*=\s*)(["'])([\s\S]*?)\2/gi;
const srcsetAttributePattern =
  /(\s(?:srcset|imagesrcset)\s*=\s*)(["'])([\s\S]*?)\2/gi;
const styleAttributePattern = /(\sstyle\s*=\s*)(["'])([\s\S]*?)\2/gi;
const styleElementPattern = /(<style\b[^>]*>)([\s\S]*?)(<\/style>)/gi;
const baseElementPattern = /<base\b[^>]*>/gi;
const baseHrefPattern = /\bhref\s*=\s*(["'])([\s\S]*?)\1/i;
const cssUrlPattern = /url\(\s*(?:(['"])([\s\S]*?)\1|([^)]*?))\s*\)/gi;
const cssImportPattern = /(@import\s+)(["'])([\s\S]*?)\2/gi;
const setCookieSplitPattern = /,(?=\s*[^;,=\s]+\s*=)/;
const srcsetCandidatePattern = /^(\S+)([\s\S]*)$/;
const leadingWhitespacePattern = /^\s*/;
const leadingDotPattern = /^\./;
const headElementPattern = /<head\b[^>]*>/i;
const passthroughResponseHeaders = [
  "accept-ranges",
  "cache-control",
  "content-disposition",
  "content-language",
  "content-range",
  "etag",
  "expires",
  "last-modified",
  "vary",
];
const forwardedRequestHeaders = [
  "accept",
  "accept-language",
  "content-type",
  "if-none-match",
  "if-modified-since",
  "range",
];
const allowedBrowserMethods = new Set([
  "DELETE",
  "GET",
  "HEAD",
  "OPTIONS",
  "PATCH",
  "POST",
  "PUT",
]);

function browserError(errorMessage, statusCode, originalCause) {
  return Object.assign(new Error(errorMessage, { cause: originalCause }), {
    statusCode: statusCode ?? 400,
  });
}

function parseBrowserUrl(value, base) {
  if (typeof value !== "string" || value.length > MAX_BROWSER_URL_LENGTH) {
    throw browserError("A valid browser URL is required");
  }
  let parsed;
  try {
    parsed = base ? new URL(value, base) : new URL(value);
  } catch (parseCause) {
    throw browserError("A valid browser URL is required", 400, parseCause);
  }
  if (!browserUrlPattern.test(parsed.protocol)) {
    throw browserError("Only HTTP and HTTPS browser URLs are supported");
  }
  if (parsed.username || parsed.password) {
    throw browserError("Browser URLs cannot contain credentials");
  }
  return parsed;
}

function proxyUrl(browserId, target) {
  return `${BROWSER_PROXY_PREFIX}/${encodeURIComponent(browserId)}/proxy?url=${encodeURIComponent(target)}`;
}

function embeddedProxyUrl(target) {
  return `?url=${encodeURIComponent(target)}`;
}

function decodeSessionId(value) {
  try {
    return decodeURIComponent(value);
  } catch (decodeCause) {
    throw browserError("Invalid browser session", 404, decodeCause);
  }
}

function requestBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > MAX_BROWSER_REQUEST_BODY_BYTES) {
        reject(browserError("Browser request body too large", 413));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

async function responseBody(response) {
  const reader = response.body?.getReader();
  if (!reader) {
    return Buffer.alloc(0);
  }
  const chunks = [];
  let size = 0;
  try {
    let done = false;
    while (!done) {
      // The chunks must be read sequentially so the response can be bounded.
      // biome-ignore lint/performance/noAwaitInLoops: response chunks must be read in order.
      const result = await reader.read();
      ({ done } = result);
      if (done) {
        continue;
      }
      const { value } = result;
      size += value.byteLength;
      if (size > MAX_BROWSER_RESPONSE_BYTES) {
        await reader.cancel();
        throw browserError("Browser response is too large", 413);
      }
      chunks.push(Buffer.from(value));
    }
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    throw error;
  }
  return Buffer.concat(chunks);
}

function shouldKeepUrl(value) {
  const trimmed = value.trim().toLowerCase();
  return (
    !trimmed ||
    trimmed.startsWith("#") ||
    trimmed.startsWith("data:") ||
    trimmed.startsWith("javascript:") ||
    trimmed.startsWith("mailto:") ||
    trimmed.startsWith("tel:") ||
    trimmed.startsWith("blob:") ||
    trimmed.startsWith("about:") ||
    trimmed.startsWith("urn:")
  );
}

function rewriteTarget(value, base) {
  const trimmed = value.trim();
  if (shouldKeepUrl(trimmed)) {
    return value;
  }
  try {
    const target = parseBrowserUrl(trimmed, base);
    return embeddedProxyUrl(target.href);
  } catch {
    return value;
  }
}

function rewriteSrcset(value, base) {
  return value
    .split(",")
    .map((candidate) => {
      const match = candidate.trim().match(srcsetCandidatePattern);
      if (!match) {
        return candidate;
      }
      const rewritten = rewriteTarget(match[1], base);
      const leading = candidate.match(leadingWhitespacePattern)?.[0] || "";
      return `${leading}${rewritten}${match[2]}`;
    })
    .join(",");
}

function rewriteCss(css, base) {
  const withUrls = css.replace(
    cssUrlPattern,
    (match, quote, quotedValue, unquotedValue) => {
      const value = quotedValue ?? unquotedValue ?? "";
      if (shouldKeepUrl(value)) {
        return match;
      }
      const rewritten = rewriteTarget(value, base);
      const wrapper = quote || "";
      return `url(${wrapper}${rewritten}${wrapper})`;
    }
  );
  return withUrls.replace(cssImportPattern, (_match, prefix, quote, value) => {
    const rewritten = rewriteTarget(value, base);
    return `${prefix}${quote}${rewritten}${quote}`;
  });
}

function scriptLocation(browserId, target) {
  const safe = (value) => JSON.stringify(value).replaceAll("<", "\\u003c");
  const safeId = safe(browserId);
  const safeTarget = safe(target);
  return `<script>(()=>{const b=${safeTarget},p=location.pathname,r=v=>{const s=typeof v==="string"?v:String(v??"");if(!s||/^(?:data|blob|javascript|mailto|tel):/i.test(s))return s;try{const u=new URL(s,b);return /^https?:$/.test(u.protocol)?p+"?url="+encodeURIComponent(u.href):s}catch{return s}};const f=window.fetch.bind(window);window.fetch=(i,o)=>f(i instanceof Request?new Request(r(i.url),i):r(i),o);const x=XMLHttpRequest.prototype.open;XMLHttpRequest.prototype.open=function(m,u,...a){return x.call(this,m,r(u),...a)};window.parent.postMessage({type:"omo-browser-location",browserId:${safeId},url:b},"*")})()</script>`;
}

function rewriteHtml(html, target, browserId) {
  const baseMatch = html.match(baseElementPattern);
  const baseHref = baseMatch?.[0].match(baseHrefPattern)?.[2];
  let documentBase = target;
  if (baseHref) {
    try {
      documentBase = parseBrowserUrl(baseHref, target).href;
    } catch {
      documentBase = target;
    }
  }
  const rewritten = html
    .replace(baseElementPattern, "")
    .replace(urlAttributePattern, (_match, prefix, quote, value) => {
      const rewrittenValue = rewriteTarget(value, documentBase);
      return `${prefix}${quote}${rewrittenValue}${quote}`;
    })
    .replace(
      srcsetAttributePattern,
      (_match, prefix, quote, value) =>
        `${prefix}${quote}${rewriteSrcset(value, documentBase)}${quote}`
    )
    .replace(
      styleAttributePattern,
      (_match, prefix, quote, value) =>
        `${prefix}${quote}${rewriteCss(value, documentBase)}${quote}`
    )
    .replace(
      styleElementPattern,
      (_match, open, value, close) =>
        `${open}${rewriteCss(value, documentBase)}${close}`
    );
  const location = scriptLocation(browserId, target);
  return headElementPattern.test(rewritten)
    ? rewritten.replace(headElementPattern, (head) => `${head}${location}`)
    : `${location}${rewritten}`;
}

function hostMatches(host, domain) {
  return host === domain || host.endsWith(`.${domain}`);
}

function pathMatches(pathname, cookiePath) {
  if (pathname === cookiePath) {
    return true;
  }
  if (!pathname.startsWith(cookiePath)) {
    return false;
  }
  return cookiePath.endsWith("/") || pathname[cookiePath.length] === "/";
}

function defaultCookiePath(pathname) {
  if (pathname?.[0] !== "/" || pathname === "/") {
    return "/";
  }
  const index = pathname.lastIndexOf("/");
  return index <= 0 ? "/" : pathname.slice(0, index);
}

function updateCookieAttribute(attributes, part) {
  const equals = part.indexOf("=");
  const attribute = (equals < 0 ? part : part.slice(0, equals)).trim();
  const attributeValue = equals < 0 ? "" : part.slice(equals + 1).trim();
  const normalized = attribute.toLowerCase();
  if (normalized === "domain" && attributeValue) {
    attributes.domain = attributeValue
      .replace(leadingDotPattern, "")
      .toLowerCase();
    attributes.hostOnly = false;
  } else if (normalized === "expires") {
    const timestamp = Date.parse(attributeValue);
    if (!Number.isNaN(timestamp)) {
      attributes.expiresAt = timestamp;
    }
  } else if (normalized === "max-age") {
    attributes.maxAge = Number(attributeValue);
  } else if (normalized === "path" && attributeValue.startsWith("/")) {
    attributes.cookiePath = attributeValue;
  } else if (normalized === "secure") {
    attributes.secure = true;
  }
}

function parseCookieAttributes(parts, targetUrl) {
  const attributes = {
    cookiePath: defaultCookiePath(targetUrl.pathname),
    domain: targetUrl.hostname.toLowerCase(),
    expiresAt: undefined,
    hostOnly: true,
    maxAge: undefined,
    secure: false,
  };
  for (const part of parts) {
    updateCookieAttribute(attributes, part);
  }
  return attributes;
}

function setCookie(session, target, value) {
  const parts = value.split(";").map((part) => part.trim());
  const first = parts.shift() || "";
  const separator = first.indexOf("=");
  if (separator <= 0) {
    return;
  }
  const name = first.slice(0, separator).trim();
  const cookieValue = first.slice(separator + 1).trim();
  const targetUrl = new URL(target);
  const attributes = parseCookieAttributes(parts, targetUrl);
  const { cookiePath, domain, expiresAt, hostOnly, maxAge, secure } =
    attributes;
  if (
    !(
      hostMatches(targetUrl.hostname.toLowerCase(), domain) &&
      // biome-ignore lint/suspicious/noUnnecessaryConditions: parser attributes may replace the initial value.
      (!secure || targetUrl.protocol === "https:")
    )
  ) {
    return;
  }
  const key = `${domain}|${cookiePath}|${name}`;
  session.cookies = session.cookies.filter((cookie) => cookie.key !== key);
  if (maxAge !== undefined && maxAge <= 0) {
    return;
  }
  if (expiresAt !== undefined && expiresAt <= Date.now()) {
    return;
  }
  session.cookies.push({
    domain,
    expiresAt: maxAge === undefined ? expiresAt : Date.now() + maxAge * 1000,
    hostOnly,
    key,
    name,
    path: cookiePath,
    secure,
    value: cookieValue,
  });
  if (session.cookies.length > MAX_BROWSER_COOKIES) {
    session.cookies.splice(0, session.cookies.length - MAX_BROWSER_COOKIES);
  }
}

function setCookies(session, target, response) {
  const { headers } = response;
  const values =
    typeof headers.getSetCookie === "function"
      ? headers.getSetCookie()
      : (headers.get("set-cookie") || "").split(setCookieSplitPattern);
  for (const value of values) {
    if (value) {
      setCookie(session, target, value);
    }
  }
}

function cookieHeader(session, target) {
  const targetUrl = new URL(target);
  const now = Date.now();
  session.cookies = session.cookies.filter(
    (cookie) => cookie.expiresAt === undefined || cookie.expiresAt > now
  );
  return session.cookies
    .filter(
      (cookie) =>
        (!cookie.hostOnly ||
          cookie.domain === targetUrl.hostname.toLowerCase()) &&
        (cookie.hostOnly ||
          hostMatches(targetUrl.hostname.toLowerCase(), cookie.domain)) &&
        pathMatches(targetUrl.pathname, cookie.path) &&
        (!cookie.secure || targetUrl.protocol === "https:")
    )
    .sort((a, b) => b.path.length - a.path.length)
    .map((cookie) => `${cookie.name}=${cookie.value}`)
    .join("; ");
}

function refererTarget(value, browserId) {
  if (!value) {
    return null;
  }
  try {
    const parsed = new URL(value);
    const match = parsed.pathname.match(browserProxyPattern);
    if (!match || decodeSessionId(match[1]) !== browserId) {
      return null;
    }
    const target = parsed.searchParams.get("url");
    return target ? parseBrowserUrl(target).href : null;
  } catch {
    // Invalid or non-proxy referers are not forwarded to the target.
    return null;
  }
}

function upstreamHeaders(req, session, target, browserId) {
  const headers = {};
  for (const name of forwardedRequestHeaders) {
    const value = req.headers[name];
    if (value) {
      headers[name] = Array.isArray(value) ? value.join(", ") : value;
    }
  }
  headers["accept-encoding"] = "identity";
  headers["user-agent"] =
    req.headers["user-agent"] ||
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 omo browser";
  const cookies = cookieHeader(session, target);
  if (cookies) {
    headers.cookie = cookies;
  }
  const referer = refererTarget(req.headers.referer, browserId);
  if (referer) {
    headers.referer = referer;
  }
  return headers;
}

function redirectResponse(res, response, target) {
  const location = response.headers.get("location");
  if (!location) {
    return null;
  }
  let redirect;
  try {
    redirect = parseBrowserUrl(location, target);
  } catch {
    return null;
  }
  const headers = responseHeaders(
    response,
    undefined,
    embeddedProxyUrl(redirect.href)
  );
  res.writeHead(response.status, headers);
  res.end();
  return redirect.href;
}

function rewriteResponseBody(output, contentType, target, browserId) {
  if (htmlContentPattern.test(contentType)) {
    return Buffer.from(rewriteHtml(output.toString("utf8"), target, browserId));
  }
  if (cssContentPattern.test(contentType)) {
    return Buffer.from(rewriteCss(output.toString("utf8"), target));
  }
  return output;
}

function responseHeaders(response, bodyLength, allowLocation) {
  const headers = {
    "Access-Control-Allow-Headers":
      "Authorization, Content-Type, Range, If-None-Match, If-Modified-Since",
    "Access-Control-Allow-Methods":
      "GET, HEAD, POST, PUT, PATCH, DELETE, OPTIONS",
    "Access-Control-Allow-Origin": "*",
  };
  for (const name of passthroughResponseHeaders) {
    const value = response.headers.get(name);
    if (value) {
      headers[name] = value;
    }
  }
  const contentType = response.headers.get("content-type");
  if (contentType) {
    headers["content-type"] = contentType;
  }
  if (allowLocation) {
    headers.location = allowLocation;
  }
  if (bodyLength !== undefined) {
    headers["content-length"] = String(bodyLength);
  }
  return headers;
}

class BrowserService {
  constructor() {
    this.sessions = new Map();
    this.cleanupTimer = setInterval(() => this.cleanup(), 5 * 60_000);
    this.cleanupTimer.unref?.();
  }

  cleanup() {
    const expiry = Date.now() - BROWSER_SESSION_IDLE_MS;
    for (const [id, session] of this.sessions) {
      if (session.lastUsed < expiry) {
        this.sessions.delete(id);
      }
    }
  }

  session(id) {
    const session = this.sessions.get(id);
    if (!session) {
      throw browserError("Browser session not found", 404);
    }
    session.lastUsed = Date.now();
    return session;
  }

  create(value) {
    const target = parseBrowserUrl(value);
    if (this.sessions.size >= MAX_BROWSER_SESSIONS) {
      const oldest = [...this.sessions.entries()]
        .sort(([, left], [, right]) => left.lastUsed - right.lastUsed)
        .at(0);
      if (oldest) {
        const [oldestId] = oldest;
        this.sessions.delete(oldestId);
      }
    }
    const id = randomUUID();
    this.sessions.set(id, {
      cookies: [],
      lastUsed: Date.now(),
      pageUrl: target.href,
    });
    return { browserId: id, url: proxyUrl(id, target.href) };
  }

  navigate(id, value) {
    const session = this.session(id);
    const target = parseBrowserUrl(value, session.pageUrl);
    session.pageUrl = target.href;
    return { browserId: id, url: proxyUrl(id, target.href) };
  }

  close(id) {
    this.sessions.delete(id);
  }

  async proxy(req, res, id, targetValue) {
    const session = this.session(id);
    const target = parseBrowserUrl(targetValue, session.pageUrl);
    session.pageUrl = target.href;
    const { method } = req;
    if (!allowedBrowserMethods.has(method)) {
      throw browserError(`Browser method ${method} is not supported`, 405);
    }
    const body =
      method === "GET" || method === "HEAD"
        ? undefined
        : await requestBody(req);
    const controller = new AbortController();
    const timeout = setTimeout(
      () => controller.abort(),
      BROWSER_REQUEST_TIMEOUT_MS
    );
    const abort = () => controller.abort();
    req.on("close", abort);
    let upstream;
    try {
      upstream = await fetch(target.href, {
        body,
        headers: upstreamHeaders(req, session, target.href, id),
        method,
        redirect: "manual",
        signal: controller.signal,
      });
    } catch (error) {
      const errorMessage =
        error instanceof Error && error.name === "AbortError"
          ? "Browser request timed out"
          : "Unable to reach browser URL";
      throw browserError(errorMessage, 502);
    } finally {
      clearTimeout(timeout);
      req.off("close", abort);
    }
    setCookies(session, target.href, upstream);
    const redirect = redirectResponse(res, upstream, target.href);
    if (redirect) {
      session.pageUrl = redirect;
      return;
    }
    const contentType = upstream.headers.get("content-type") || "";
    const output = method === "HEAD" ? undefined : await responseBody(upstream);
    const rewritten = output
      ? rewriteResponseBody(output, contentType, target.href, id)
      : output;
    const headers = responseHeaders(upstream, rewritten?.length);
    res.writeHead(upstream.status, headers);
    res.end(rewritten);
  }
}

module.exports = {
  BrowserService,
  browserNavigatePattern,
  browserProxyPattern,
  browserSessionPattern,
};
