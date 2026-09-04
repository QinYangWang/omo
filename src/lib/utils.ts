import { type ClassValue, clsx } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

const uuidPattern = /^(........)(....)(....)(....)(............)$/;

/**
 * crypto.randomUUID requires a secure context; fall back to getRandomValues
 * (or Math.random) when the app is served over plain HTTP on a public IP.
 */
export function randomUUID(): string {
  if (
    typeof crypto !== "undefined" &&
    typeof crypto.randomUUID === "function"
  ) {
    return crypto.randomUUID();
  }
  const bytes = new Uint8Array(16);
  if (typeof crypto !== "undefined" && crypto.getRandomValues) {
    crypto.getRandomValues(bytes);
  } else {
    for (let i = 0; i < bytes.length; i += 1) {
      bytes[i] = Math.floor(Math.random() * 256);
    }
  }
  bytes[6] = 64 + (bytes[6] % 16);
  bytes[8] = 128 + (bytes[8] % 64);
  const hex = [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
  return hex.replace(uuidPattern, "$1-$2-$3-$4-$5");
}
