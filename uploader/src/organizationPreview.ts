import type {
  OrganizationData,
  OrganizationEvent,
  RecordingActivity,
} from "./types";

// Explicitly fictional browser-only fixtures; never used by Electron or the receiver.
export function organizationPreview() {
  const event: OrganizationEvent = {
    id: "fictional-node",
    title: "学生回答",
    detail: "老师询问如何判断函数在一个区间上递增，随后一位学生作答。",
    question: "这句话是哪位学生说的？",
    sources: [],
    student_id: null,
    role: "unknown",
    resolution: "pending",
    at: "2026-10-13T08:26:00",
    offset: 960,
    asset_id: "asset_demo_1",
    speaker_label: "SPEAKER_01",
    context: [
      {
        id: "fictional-before",
        start: 940,
        text: "怎样判断函数在一个区间上递增？",
        speaker: "SPEAKER_00",
        target: false,
      },
      {
        id: "fictional-target",
        start: 960,
        text: "后面的函数值比前面的大。",
        speaker: "SPEAKER_01",
        target: true,
      },
      {
        id: "fictional-after",
        start: 970,
        text: "这里说的前后两个点，需要满足什么条件？",
        speaker: "SPEAKER_00",
        target: false,
      },
    ],
  };
  const activity: RecordingActivity = {
    id: "fictional-activity",
    title: "函数的单调性",
    kind: "class",
    period: "第一节课",
    started_at: "2026-10-13T08:10:00",
    ended_at: "2026-10-13T08:52:00",
    asset_ids: ["asset_demo_1", "asset_demo_2"],
    class_id: "fictional-class3",
    class_source: "schedule",
    status: "draft",
    revision: 1,
    stale: false,
    lesson_id: null,
    events: [event],
    notes: [],
  };
  let data: OrganizationData = {
    classes: [
      { id: "fictional-class3", name: "高一（3）班 · 虚构" },
      { id: "fictional-class5", name: "高一（5）班 · 虚构" },
    ],
    students: [
      { id: "fictional-student-a", name: "张明", class_id: "fictional-class3" },
      { id: "fictional-student-b", name: "李华", class_id: "fictional-class3" },
      { id: "fictional-student-c", name: "张明", class_id: "fictional-class5" },
      { id: "fictional-student-d", name: "单宇", class_id: "fictional-class3" },
    ],
    schedule: [
      {
        id: "fictional-schedule",
        weekday: 2,
        start: "08:10",
        end: "08:50",
        period: "第一节课",
        class_id: "fictional-class3",
        revision: 1,
      },
    ],
    activities: [
      activity,
      {
        ...structuredClone(activity),
        id: "fictional-talk",
        title: "作业与学习习惯",
        kind: "conversation",
        period: "个别谈话",
        started_at: "2026-10-13T10:05:00",
        ended_at: "2026-10-13T10:23:00",
        asset_ids: ["asset_demo_3"],
        class_id: null,
        class_source: "unknown",
        events: [
          {
            ...event,
            id: "fictional-talk-node",
            at: "2026-10-13T10:08:00",
            offset: 180,
            title: "学生询问作业",
            detail: "谈话中提到昨天的作业，回答者尚不明确。",
            context: [
              {
                id: "fictional-talk-quote",
                start: 180,
                text: "老师，我昨天的作业有一道还不会。",
                speaker: "SPEAKER_01",
                target: true,
              },
            ],
          },
        ],
      },
      {
        ...structuredClone(activity),
        id: "fictional-history",
        title: "函数的表示方法",
        started_at: "2026-10-12T08:10:00",
        ended_at: "2026-10-12T08:52:00",
        status: "saved",
        lesson_id: "fictional-lesson",
        events: [
          { ...event, id: "fictional-history-node", resolution: "unknown" },
        ],
      },
      {
        ...structuredClone(activity),
        id: "fictional-history2",
        period: "第二节课",
        title: "函数的定义域",
        started_at: "2026-10-12T09:10:00",
        ended_at: "2026-10-12T09:52:00",
        status: "saved",
        lesson_id: "fictional-lesson2",
        events: [
          { ...event, id: "fictional-history2-node", resolution: "unknown" },
        ],
      },
    ],
  };
  try {
    const stored = sessionStorage.getItem("fictional-organization-v1");
    if (stored) data = JSON.parse(stored);
  } catch {
    /* Preview may use storage-disabled browsers. */
  }
  return {
    async organization() {
      return structuredClone(data);
    },
    async organize(input: Record<string, unknown>) {
      if (input.action === "schedule") {
        data.schedule = structuredClone(
          input.entries as OrganizationData["schedule"],
        ).map((e, i) => ({
          ...e,
          revision: i === 0 ? Number(input.revision) + 1 : 1,
        }));
      } else {
        const a = data.activities.find((a) => a.id === input.id);
        if (!a || a.revision !== input.revision)
          throw new Error("记录已更新，请刷新后再修改");
        if (input.action === "class") {
          a.class_id = input.class_id as string | null;
          a.class_source = "manual";
        }
        if (input.action === "publish") {
          if (a.events.some((e) => e.resolution === "pending"))
            throw new Error("请先处理待确认项");
          a.status = "saved";
        }
        const e = a.events.find((e) => e.id === input.event_id);
        if (input.action === "resolve" && e) {
          e.student_id = input.student_id as string | null;
          e.role = input.role as OrganizationEvent["role"];
          e.resolution = e.role === "unknown" ? "unknown" : "confirmed";
        }
        if (input.action === "note" && e) {
          e.note = input.text as string;
          e.resolution = "confirmed";
          a.notes.push({
            event_id: e.id,
            text: e.note,
            created_at: new Date().toISOString(),
          });
        }
        a.revision++;
      }
      try {
        sessionStorage.setItem(
          "fictional-organization-v1",
          JSON.stringify(data),
        );
      } catch {
        /* In-memory preview remains usable. */
      }
      return structuredClone(data);
    },
  };
}
