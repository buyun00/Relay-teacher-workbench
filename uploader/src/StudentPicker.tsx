import { useEffect, useId, useMemo, useRef, useState } from "react";
import { ChevronDown, Search } from "lucide-react";
import { pinyin } from "pinyin-pro";
import type { OrganizationData } from "./types";

export function StudentPicker({
  data,
  classId,
  value,
  role,
  disabled,
  onSelect,
}: {
  data: OrganizationData;
  classId: string | null;
  value: string | null;
  role: string;
  disabled?: boolean;
  onSelect: (studentId: string | null, role: string) => void;
}) {
  const [open, setOpen] = useState(false),
    [query, setQuery] = useState(""),
    [active, setActive] = useState(0);
  const root = useRef<HTMLDivElement>(null),
    input = useRef<HTMLInputElement>(null),
    id = useId();
  const indexed = useMemo(() => {
    const seen = new Set<string>();
    const classNames = new Map(data.classes.map((c) => [c.id, c.name]));
    const memberships = new Map<string, Set<string>>();
    for (const s of data.students) {
      if (!memberships.has(s.id)) memberships.set(s.id, new Set());
      memberships.get(s.id)!.add(classNames.get(s.class_id) || "未命名班级");
    }
    return data.students
      .filter(
        (s) =>
          (!classId || s.class_id === classId) &&
          !seen.has(s.id) &&
          !!seen.add(s.id),
      )
      .map((s) => {
        const words = pinyin(s.name, {
          toneType: "none",
          type: "array",
          mode: "surname",
        });
        const classes = [...(memberships.get(s.id) || [])].join("、");
        return {
          ...s,
          classes,
          search: [
            s.name,
            s.id,
            words.join(""),
            words.map((w) => w[0]).join(""),
          ].map((v) => v.toLowerCase()),
        };
      });
  }, [data.students, data.classes, classId]);
  const normalized = query.toLowerCase().replace(/[\s'’]/g, "");
  const results = indexed.filter((s) =>
    s.search.some((key) => key.includes(normalized)),
  );
  const options = [
    ...results
      .slice(0, 50)
      .map((s) => ({
        key: s.id,
        label: s.name,
        detail: s.classes + " · 学号 " + s.id,
        role: "student",
      })),
    ...(!query
      ? [
          {
            key: "",
            label: "教师",
            detail: "将此句标为教师发言",
            role: "teacher",
          },
          {
            key: "",
            label: "记不清，保留未知",
            detail: "不推定学生身份",
            role: "unknown",
          },
        ]
      : []),
  ];
  const label = value
    ? data.students.find((s) => s.id === value)?.name || "学生已不在名单"
    : role === "teacher"
      ? "教师"
      : "指定说话人";
  useEffect(() => {
    if (!open) return;
    input.current?.focus();
    const outside = (e: PointerEvent) => {
      if (!root.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", outside);
    return () => document.removeEventListener("pointerdown", outside);
  }, [open]);
  useEffect(() => {
    setActive(0);
  }, [query]);
  useEffect(() => {
    if (open)
      document
        .getElementById(`${id}-${active}`)
        ?.scrollIntoView({ block: "nearest" });
  }, [active, open, id]);
  const choose = (i: number) => {
    const option = options[i];
    if (option) {
      onSelect(option.key || null, option.role);
      setOpen(false);
      setQuery("");
    }
  };
  return (
    <div className="student-picker" ref={root}>
      {!open ? (
        <button
          className="speaker-button"
          disabled={disabled}
          onClick={() => {
            setQuery("");
            setOpen(true);
          }}
          aria-label="指定说话人"
          aria-expanded={false}
        >
          <span>{label}</span>
          <ChevronDown size={14} />
        </button>
      ) : (
        <>
          <div className="speaker-input">
            <Search size={14} />
            <input
              ref={input}
              role="combobox"
              aria-label="搜索学生"
              aria-expanded={true}
              aria-controls={id}
              aria-autocomplete="list"
              aria-activedescendant={
                options[active] ? `${id}-${active}` : undefined
              }
              placeholder="姓名 / 拼音 / 首字母"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.nativeEvent.isComposing) return;
                if (e.key === "Escape") {
                  e.preventDefault();
                  setOpen(false);
                }
                if (e.key === "ArrowDown") {
                  e.preventDefault();
                  setActive((i) => Math.min(i + 1, options.length - 1));
                }
                if (e.key === "ArrowUp") {
                  e.preventDefault();
                  setActive((i) => Math.max(0, i - 1));
                }
                if (e.key === "Enter") {
                  e.preventDefault();
                  choose(active);
                }
                if (e.key === "Tab") setOpen(false);
              }}
            />
          </div>
          <div
            className="speaker-options"
            role="listbox"
            id={id}
            aria-label="匹配学生"
          >
            <small>
              {classId ? "当前班级" : "全部班级"} · {results.length} 位匹配
            </small>
            {options.map((s, i) => (
              <button
                type="button"
                id={`${id}-${i}`}
                role="option"
                aria-selected={active === i}
                className={active === i ? "active" : ""}
                key={s.key || s.role}
                onPointerMove={() => setActive(i)}
                onClick={() => choose(i)}
              >
                <b>{s.label}</b>
                <small>{s.detail}</small>
              </button>
            ))}
            {!options.length && <p>没有匹配的学生，请检查班级或姓名。</p>}
          </div>
        </>
      )}
    </div>
  );
}
