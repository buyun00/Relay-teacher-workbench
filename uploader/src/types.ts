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
  chatModels: ChatModel[];
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
  attachments?: ChatAttachment[];
  createdAt: string;
  updatedAt: string;
  state?: ChatTurn["state"] | null;
  archived_at?: string | null;
  title_source?: "fallback" | "ai";
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
  archiveTask(input: { id: string; archived: boolean }): Promise<unknown>;
  readChat(id: string): Promise<ChatView>;
  selectChatFiles(id: string): Promise<ChatAttachment[]>;
  importChatFiles(input: { id: string; files: File[] }): Promise<ChatAttachment[]>;
  removeChatAttachment(input: { id: string; attachmentId: string }): Promise<unknown>;
  previewChatAttachment(input: { id: string; attachmentId: string; full?: boolean }): Promise<string | null>;
  saveChatAttachment(input: { id: string; attachmentId: string }): Promise<unknown>;
  sendChat(input: { id: string; content: string; attachments?: string[] }): Promise<unknown>;
  selectChatModel(input: { id: string; modelId: string }): Promise<ChatView>;
  cancelChat(id: string): Promise<unknown>;
  openLink(url: string): Promise<unknown>;
  copyText(value: string): Promise<unknown>;
  subscribeChat(callback: (view: ChatView) => void): () => void;
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
export interface ChatModel { id: string; label: string; purpose: string }
export interface ChatAttachment {
  id: string; filename: string; mime: string; bytes: number;
  status?: "ready" | "uploading" | "error"; uploadedBytes?: number; error?: string;
}
export interface ChatTurn {
  id: string; chat_id: string; content: string; answer: string;
  state: "queued" | "running" | "cancelling" | "completed" | "cancelled" | "failed" | "interrupted";
  model_id?: string | null; error: string | null; created_at: string;
  attachments?: ChatAttachment[];
}
export interface ChatEvent {
  seq: number; chat_id: string; turn_id: string | null; kind: string; at: string;
  payload: { text?: string; id?: string; name?: string; args?: Record<string, unknown>; result?: string; failed?: boolean };
}
export interface ChatView {
  chat: { id: string; title: string; hermes_session_id: string; native_tip: string;
    route_state: "triage" | "locked"; model_id: string | null; route_reason: string | null;
    archived_at?: string | null; title_source?: "fallback" | "ai"; };
  turns: ChatTurn[]; events: ChatEvent[]; cursor: number; workspace_id: string;
  connection?: "online" | "offline"; connectionError?: string | null;
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
