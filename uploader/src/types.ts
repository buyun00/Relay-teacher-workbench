export type LocalState =
  "queued" | "uploading" | "retry" | "attention" | "missing" | "received";
export type RemoteState =
  | "received"
  | "awaiting_lesson"
  | "queued"
  | "transcribing"
  | "transcribed"
  | "analyzing"
  | "analyzed"
  | "stale"
  | "needs_attention"
  | "unknown";
export interface Recording {
  id: string;
  sha256: string;
  filename: string;
  bytes: number;
  modifiedAt: string;
  sourceName: string;
  createdAt: string;
  state: LocalState;
  uploadedBytes: number;
  attempts: number;
  error: string | null;
  nextTryAt: number;
  receipt: {
    asset_id: string;
    received_at: string;
    workspace_id: string;
    upload_id: string;
    sha256: string;
    byte_length: number;
  } | null;
  remote: {
    state: RemoteState;
    asset_id?: string;
    lesson_ids?: string[];
    artifact_ids?: string[];
    jobs?: { id: string; kind: string; state: string }[];
    workflow?: { id: string; state: RemoteState; error: string | null; complete: boolean;
      artifacts: { id: string; kind: string; title: string }[] } | null;
  } | null;
  remoteCheckedAt: string | null;
}
export interface Device {
  id: string;
  name: string;
  root: string;
  connected: boolean;
  safeToUnplug: boolean;
  fileCount?: number;
  pending?: number;
  capacity?: number;
  freeBytes?: number;
  lastSeenAt?: string;
  lastScanAt?: string;
  problem?: string | null;
}
export interface Settings {
  endpoint: string;
  workspaceId: string;
  clientId: string;
  hasToken: boolean;
  pauseUploads: boolean;
  startAtLogin: boolean;
  releaseRepo: string;
  devices: {
    id: string;
    name: string;
    originalRoot: string;
    volumeId?: string | null;
  }[];
}
export interface Snapshot {
  mode: "desktop" | "preview";
  version: string;
  tasks: LocalTask[];
  deviceState: "checking" | "ready" | "error";
  config: Settings;
  dataDir: string;
  devices: Device[];
  candidates: {
    volumeId: string;
    root: string;
    name: string;
    capacity?: number;
    freeBytes?: number;
  }[];
  files: Recording[];
  copying: {
    filename: string;
    bytes: number;
    copied: number;
    deviceId: string;
  } | null;
  scanning: boolean;
  connection: {
    state: "unconfigured" | "online" | "offline" | "checking";
    detail: string;
    checkedAt: string | null;
  };
  update: {
    state: string;
    detail: string;
    version?: string;
    progress?: number;
  };
  logs: { id: number; at: string; level: string; message: string }[];
}
export interface ManualImportResult {
  added: number;
  duplicates: number;
  failed: { filename: string; detail: string }[];
}
export interface LocalTask {
  id: string;
  title: string;
  draft: string;
  createdAt: string;
  updatedAt: string;
}
export interface ClientAPI {
  snapshot(): Promise<Snapshot>;
  subscribe(callback: (snapshot: Snapshot) => void): () => void;
  saveSettings(
    input: Partial<Settings> & { token?: string; clearToken?: boolean },
  ): Promise<unknown>;
  selectFolder(): Promise<unknown>;
  selectFiles(): Promise<ManualImportResult | null>;
  createTask(): Promise<LocalTask>;
  saveTaskDraft(input: { id: string; draft: string }): Promise<unknown>;
  bindCandidate(input: { volumeId: string; name?: string }): Promise<unknown>;
  unbind(id: string): Promise<unknown>;
  scan(): Promise<unknown>;
  pause(paused: boolean): Promise<unknown>;
  retry(id: string): Promise<unknown>;
  health(): Promise<unknown>;
  refreshStatus(): Promise<unknown>;
  readResults(id: string): Promise<RecordingResults>;
  checkUpdates(): Promise<unknown>;
  installUpdate(): Promise<unknown>;
  openDataDir(): Promise<unknown>;
}
export interface RecordingResults {
  state: RemoteState;
  complete?: boolean;
  reports: { id: string; kind: "brief" | "preparation"; title: string; text: string;
    stale: number; warning?: string | null; created_at: string }[];
}
declare global {
  interface Window {
    classroom?: ClientAPI;
  }
}
