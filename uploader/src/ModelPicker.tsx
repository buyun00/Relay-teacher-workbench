import { useEffect, useId, useRef, useState, type KeyboardEvent } from "react";
import { Check, ChevronDown } from "lucide-react";
import type { ChatModel } from "./types";

export function ModelPicker({ models, value, disabled, onChange }: {
  models: ChatModel[]; value: string; disabled: boolean; onChange: (id: string) => void;
}) {
  const options = [{ id: "auto", label: "自动 · DS 了解需求", purpose: "根据前几轮需求选择合适的模型" }, ...models];
  const selected = options.find((option) => option.id === value);
  const [open, setOpen] = useState(false);
  const [activeId, setActiveId] = useState(value);
  const root = useRef<HTMLDivElement>(null), trigger = useRef<HTMLButtonElement>(null);
  const listId = useId();
  const expanded = open && !disabled;
  const index = Math.max(0, options.findIndex((option) => option.id === activeId));
  useEffect(() => { setOpen(false); }, [value, disabled]);
  useEffect(() => {
    if (!expanded) return;
    const dismiss = (event: PointerEvent) => {
      if (event.target instanceof Node && !root.current?.contains(event.target)) setOpen(false);
    };
    const blur = () => setOpen(false);
    document.addEventListener("pointerdown", dismiss);
    window.addEventListener("blur", blur);
    return () => { document.removeEventListener("pointerdown", dismiss); window.removeEventListener("blur", blur); };
  }, [expanded]);
  const show = () => { setActiveId(value); setOpen(true); };
  const choose = (id: string) => {
    setOpen(false);
    trigger.current?.focus();
    if (id !== value) onChange(id);
  };
  const keyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
      event.preventDefault();
      if (!expanded) { show(); return; }
      const next = event.key === "Home" ? 0 : event.key === "End" ? options.length - 1
        : (index + (event.key === "ArrowDown" ? 1 : -1) + options.length) % options.length;
      setActiveId(options[next].id);
    } else if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      if (expanded) choose(options[index].id); else show();
    } else if (event.key === "Escape" && expanded) {
      event.preventDefault(); event.stopPropagation(); setOpen(false);
    } else if (event.key === "Tab") setOpen(false);
  };
  return <div className="model-picker" ref={root} onBlur={(event) => {
    if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setOpen(false);
  }}>
    <button ref={trigger} type="button" className="model-choice" role="combobox" aria-label="对话模型"
      aria-expanded={expanded} aria-controls={expanded ? listId : undefined} aria-haspopup="listbox"
      aria-activedescendant={expanded ? `${listId}-${index}` : undefined} disabled={disabled}
      onClick={() => expanded ? setOpen(false) : show()} onKeyDown={keyDown}>
      <span>{selected?.label || value}</span><ChevronDown size={13} aria-hidden="true" />
    </button>
    {expanded && <div className="model-menu" role="listbox" aria-label="选择对话模型" id={listId}>
      {options.map((option, i) => <button key={option.id} id={`${listId}-${i}`} type="button" role="option"
        aria-selected={option.id === value} tabIndex={-1}
        className={"model-option " + (option.id === activeId ? "is-active " : "") + (option.id === value ? "is-selected" : "")}
        onMouseDown={(event) => event.preventDefault()} onPointerMove={() => setActiveId(option.id)} onClick={() => choose(option.id)}>
        <span><strong>{option.label}</strong><small>{option.purpose}</small></span>
        {option.id === value && <Check size={15} aria-hidden="true" />}
      </button>)}
    </div>}
  </div>;
}
