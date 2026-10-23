// loam-storage.ts — Logos Storage through the Loam app (ADR 0020, amended 2026-10-23).
//
// Loam runs ONE Storage fetch client for the phone and fetches CIDs as background jobs: the job keeps
// going when this app is closed or killed. Ask for a CID (fetch), poll status until "done", then copy
// it out of Loam's cache (saveTo). Loam knows CIDs only; checking what the bytes are is the app's job.
//
// Needs the shared-node client (plugins/withDeliveryClient.js) and a Loam with Storage. Without them,
// available() is false and every call returns null: keep your own fallback.
import { NativeModules } from "react-native";

const Client = (NativeModules as any).LogosDeliveryClient;

export type JobState = "none" | "queued" | "fetching" | "done" | "failed" | "cancelled";
export interface JobStatus { cid: string; state: JobState; bytes?: number; total?: number; error?: string }
export interface StorageInfo { enabled?: boolean; state?: "off" | "idle" | "running" | "fetching" | "failed"; running: boolean; online: boolean; cacheBytes: number; cacheFiles: number; cacheCap: number; jobs: JobStatus[]; nodeError?: string }
export interface Peer { peerId: string; addrs: string[]; spr?: string }

const parse = <T>(s: unknown): T | null => {
  if (typeof s !== "string" || !s) return null;
  try { const v = JSON.parse(s); return v && typeof v === "object" ? (v as T) : null; } catch { return null; }
};

/** Loam with Storage is reachable (the client is bound and the service answers storageInfo). */
export async function available(): Promise<boolean> {
  if (!Client?.storageInfo) return false;
  const i = parse<StorageInfo & { error?: string; enabled?: boolean }>(await Client.storageInfo());
  return !!i && !i.error && i.enabled !== false;   // the owner can turn Storage off in Loam
}
export async function info(): Promise<StorageInfo | null> { return Client?.storageInfo ? parse(await Client.storageInfo()) : null; }

/** Start (or join) the background job for `cid`. `peers`: nodes known to hold it (dialled first). */
export async function fetch(cid: string, peers: Peer[] = []): Promise<JobStatus | null> {
  return Client?.storageFetch ? parse(await Client.storageFetch(cid, JSON.stringify(peers.slice(0, 8)))) : null;
}
export async function status(cid: string): Promise<JobStatus | null> { return Client?.storageStatus ? parse(await Client.storageStatus(cid)) : null; }
export async function cancel(cid: string): Promise<JobStatus | null> { return Client?.storageCancel ? parse(await Client.storageCancel(cid)) : null; }

/** Copy a finished CID out of Loam's cache to `path` (a file this app owns). Resolves the byte count. */
export async function saveTo(cid: string, path: string): Promise<number> {
  if (!Client?.storageSaveTo) throw new Error("this build has no Loam storage client");
  return Number(await Client.storageSaveTo(cid, path));
}
