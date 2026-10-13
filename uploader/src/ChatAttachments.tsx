import { useEffect, useState } from "react";
import { Download, File, Image, LoaderCircle, X } from "lucide-react";
import { bridge } from "./bridge";
import type { ChatAttachment } from "./types";

type Run = (action: () => Promise<unknown>, success?: string) => Promise<void>;
const size = (n: number) => n >= 1e6 ? (n / 1e6).toFixed(1) + " MB" : n >= 1e3 ? (n / 1e3).toFixed(1) + " KB" : n + " B";

export function ChatAttachments({ chatId, files, run, removable = false, disabled = false, label }: {
  chatId: string; files: ChatAttachment[]; run: Run; removable?: boolean; disabled?: boolean; label?: string;
}) {
  const [preview, setPreview] = useState<{ src: string; file: ChatAttachment } | null>(null);
  useEffect(() => {
    if (!preview) return;
    const close = (e: KeyboardEvent) => { if (e.key === "Escape") setPreview(null); };
    document.addEventListener("keydown", close); return () => document.removeEventListener("keydown", close);
  }, [preview]);
  return <>
    <div className="chat-attachments" aria-label={label || (removable ? "待发送附件" : "消息附件")}>
      {files.map(file => <Attachment key={file.id} chatId={chatId} file={file} removable={removable} disabled={disabled} run={run}
        preview={() => void run(async () => {
          const src = await bridge.previewChatAttachment({ id: chatId, attachmentId: file.id, full: true });
          if (src) setPreview({ src, file });
        })} />)}
    </div>
    {preview && <div className="attachment-backdrop" role="presentation" onClick={() => setPreview(null)}>
      <section role="dialog" aria-modal="true" aria-label={"图片预览：" + preview.file.filename} className="attachment-dialog" onClick={e => e.stopPropagation()}>
        <header><span>{preview.file.filename}</span><button className="icon-button" autoFocus aria-label="关闭图片预览" onClick={() => setPreview(null)}><X size={18} /></button></header>
        <img src={preview.src} alt={preview.file.filename} />
        <button className="button secondary" onClick={() => void run(() => bridge.saveChatAttachment({ id: chatId, attachmentId: preview.file.id }))}><Download size={15} />保存图片</button>
      </section>
    </div>}
  </>;
}

function Attachment({ chatId, file, removable, disabled, run, preview }: {
  chatId: string; file: ChatAttachment; removable: boolean; disabled: boolean; run: Run; preview: () => void;
}) {
  const [src, setSrc] = useState<string | null>(null);
  const image = file.mime.startsWith("image/");
  useEffect(() => {
    if (!image) return;
    let live = true;
    void bridge.previewChatAttachment({ id: chatId, attachmentId: file.id }).then(src => { if (live) setSrc(src); }).catch(() => {});
    return () => { live = false; };
  }, [chatId, file.id, image]);
  const progress = file.status === "uploading" ? "上传 " + Math.round((file.uploadedBytes || 0) / Math.max(1, file.bytes) * 100) + "%" : file.status === "error" ? "等待重试" : size(file.bytes);
  return <div className={"chat-attachment " + (image ? "is-image " : "") + (file.status === "error" ? "has-error" : "")} title={file.error || file.filename}>
    {image ? <button className="attachment-image" aria-label={"预览图片：" + file.filename} onClick={preview}>
      {src ? <img src={src} alt={file.filename} /> : <Image size={24} />}
    </button> : <span className="attachment-file-icon"><File size={23} /></span>}
    <div className="attachment-info"><span>{file.filename}</span><small>{file.status === "uploading" && <LoaderCircle size={10} className="spin" />}{progress}</small></div>
    {removable ? <button className="attachment-action" disabled={disabled} aria-label={"移除附件：" + file.filename}
      onClick={() => void run(() => bridge.removeChatAttachment({ id: chatId, attachmentId: file.id }))}><X size={12} /></button>
      : <button className="attachment-action" aria-label={"保存附件：" + file.filename} onClick={() => void run(() => bridge.saveChatAttachment({ id: chatId, attachmentId: file.id }))}><Download size={12} /></button>}
  </div>;
}
