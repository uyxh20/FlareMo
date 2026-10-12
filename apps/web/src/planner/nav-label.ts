// The planner's page names, on their own (fork-owned add-on,
// docs/planning-cockpit-implementation-plan.md, section 5, and
// docs/planning-cockpit-goals-review.md).
//
// The sidebar links live in the entry chunk, while each page's copy (strings.ts,
// goals-strings.ts) belongs to the lazy page. Keeping the words the links need in
// a module of their own means the links do not drag the whole dictionaries into
// every page load. The pages read their titles from here, so a link and its page
// can never name it differently.

const names = { en: "Cockpit", zhCN: "驾驶舱" } as const;
const goalsNames = { en: "Goals", zhCN: "目标" } as const;
const reviewNames = { en: "Weekly review", zhCN: "每周复盘" } as const;

/** What the cockpit is called in an app language: Chinese for zh-CN, English otherwise. */
export function plannerNavLabelFor(locale: string): string {
  return locale === "zh-CN" ? names.zhCN : names.en;
}

/** The Goals page's name, like `plannerNavLabelFor`. */
export function plannerGoalsNavLabelFor(locale: string): string {
  return locale === "zh-CN" ? goalsNames.zhCN : goalsNames.en;
}

/** The weekly review's name, like `plannerNavLabelFor`. */
export function plannerReviewNavLabelFor(locale: string): string {
  return locale === "zh-CN" ? reviewNames.zhCN : reviewNames.en;
}

export const plannerNavLabelEn = names.en;
export const plannerNavLabelZhCN = names.zhCN;
export const plannerGoalsNavLabelEn = goalsNames.en;
export const plannerGoalsNavLabelZhCN = goalsNames.zhCN;
export const plannerReviewNavLabelEn = reviewNames.en;
export const plannerReviewNavLabelZhCN = reviewNames.zhCN;

/** What a screen reader hears after the review's link while a review is due. */
export function plannerReviewDueLabelFor(locale: string): string {
  return locale === "zh-CN" ? "待完成" : "due";
}
