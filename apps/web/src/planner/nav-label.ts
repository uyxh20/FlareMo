// The cockpit's name, on its own (fork-owned add-on,
// docs/planning-cockpit-implementation-plan.md, section 5).
//
// The sidebar link lives in the entry chunk, while the cockpit's copy
// (strings.ts) belongs to the lazy page. Keeping the one word the link needs in a
// module of its own means the link does not drag the whole dictionary into every
// page load. strings.ts reads its `nav` and `title` from here, so the link and
// the page can never name the cockpit differently.

const names = { en: "Cockpit", zhCN: "驾驶舱" } as const;

/** What the cockpit is called in an app language: Chinese for zh-CN, English otherwise. */
export function plannerNavLabelFor(locale: string): string {
  return locale === "zh-CN" ? names.zhCN : names.en;
}

export const plannerNavLabelEn = names.en;
export const plannerNavLabelZhCN = names.zhCN;
