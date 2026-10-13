import { GraduationCap, Minus, Square, X } from "lucide-react";

export function WindowTitleBar() {
  return (
    <header className="window-titlebar" aria-label="窗口标题栏">
      <div className="window-titlebar-content">
        <div className="app-name">
          <span className="app-mark"><GraduationCap size={21} strokeWidth={1.7} /></span>
          课堂连接
        </div>
      </div>
      {!window.classroom && <div className="window-controls-preview" aria-hidden="true">
        <span><Minus size={16} /></span><span><Square size={14} /></span><span><X size={18} /></span>
      </div>}
    </header>
  );
}
