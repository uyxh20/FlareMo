import { animate } from "motion";
import { motion } from "motion/react";
import { type ReactNode, useEffect, useRef, useState } from "react";

/* ============ 动效 token：全站平滑入场与物理弹跳 ============ */

/** 张扬档入场缓动（ease-out-quint 系） */
export const easeOutQuint: [number, number, number, number] = [
  0.22, 1, 0.36, 1,
];

/** 带轻微过冲的 spring（横幅、弹入用） */
export const springPop = {
  type: "spring" as const,
  stiffness: 260,
  damping: 18,
};

/* ============ SSR 安全入场：hydration 不改变首帧可见状态 ============ */

/**
 * hydration 前渲染普通元素（SSR/首帧内容完整可见，不伤 SEO/LCP）。挂载后
 * 换成 motion 元素时禁止重新应用 hidden 初始态，避免 Hero 已经可见却在
 * hydration 后短暂变透明。进入视口的元素仍保留 motion transition，首帧
 * 以最终状态为准也让隐藏标签页恢复时直接显示可用内容。
 */
export function useHydrated() {
  const [hydrated, setHydrated] = useState(false);
  useEffect(() => {
    setHydrated(true);
  }, []);
  return hydrated;
}

/** 系统「减弱动态」偏好（SSR 安全）；为真时所有动效组件直接渲染静态内容 */
export function useReducedMotionPreference() {
  const [reduced, setReduced] = useState(() => {
    if (
      typeof window === "undefined" ||
      typeof window.matchMedia !== "function"
    ) {
      return false;
    }
    return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  });
  useEffect(() => {
    const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    const update = () => setReduced(mq.matches);
    update();
    mq.addEventListener("change", update);
    return () => mq.removeEventListener("change", update);
  }, []);
  return reduced;
}

const entranceViewport = { once: true, margin: "0px 0px -64px 0px" } as const;

/* ============ Reveal：区块入场（进入视口一次） ============ */

export function Reveal({
  children,
  className,
  delay = 0,
}: {
  children: ReactNode;
  className?: string;
  delay?: number;
}) {
  const hydrated = useHydrated();
  const reduced = useReducedMotionPreference();
  if (!hydrated || reduced) return <div className={className}>{children}</div>;
  return (
    <motion.div
      className={className}
      initial={false}
      whileInView={{ opacity: 1, y: 0 }}
      viewport={entranceViewport}
      transition={{ duration: 0.5, ease: easeOutQuint, delay }}
    >
      {children}
    </motion.div>
  );
}

/* ============ RevealGroup + RevealItem：列表/网格错峰入场 ============ */

export function RevealGroup({
  children,
  className,
  stagger = 0.08,
}: {
  children: ReactNode;
  className?: string;
  stagger?: number;
}) {
  const hydrated = useHydrated();
  const reduced = useReducedMotionPreference();
  if (!hydrated || reduced) return <div className={className}>{children}</div>;
  return (
    <motion.div
      className={className}
      initial={false}
      whileInView="visible"
      viewport={entranceViewport}
      variants={{
        hidden: {},
        visible: {
          transition: { staggerChildren: stagger, delayChildren: 0.05 },
        },
      }}
    >
      {children}
    </motion.div>
  );
}

export function RevealItem({
  children,
  className,
  y = 20,
}: {
  children: ReactNode;
  className?: string;
  y?: number;
}) {
  return (
    <motion.div
      className={className}
      initial={false}
      variants={{
        hidden: { opacity: 0, y },
        visible: {
          opacity: 1,
          y: 0,
          transition: { duration: 0.4, ease: easeOutQuint },
        },
      }}
    >
      {children}
    </motion.div>
  );
}

/** 惊喜元素弹入：spring 过冲（横幅、提示等） */
export function PopIn({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  const hydrated = useHydrated();
  const reduced = useReducedMotionPreference();
  if (!hydrated || reduced) return <div className={className}>{children}</div>;
  return (
    <motion.div
      className={className}
      initial={false}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      transition={springPop}
    >
      {children}
    </motion.div>
  );
}

/* ============ AnimatedNumber：数字滚动（SSR 渲染最终值，挂载后 0 → 目标） ============ */

function formatNumber(n: number, locale: string): string {
  return new Intl.NumberFormat(locale).format(n);
}

export function AnimatedNumber({
  value,
  className,
  prefix = "",
  suffix = "",
  locale = "en-US",
}: {
  value: number;
  className?: string;
  prefix?: string;
  suffix?: string;
  locale?: string;
}) {
  const reduced = useReducedMotionPreference();
  const [display, setDisplay] = useState(value);
  const started = useRef(false);

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    if (
      reduced ||
      (typeof document !== "undefined" &&
        document.visibilityState !== "visible")
    ) {
      setDisplay(value);
      return;
    }
    const controls = animate(0, value, {
      duration: 1.2,
      delay: 0.15,
      ease: [0.16, 1, 0.3, 1], // easeOutExpo
      onUpdate: (v) => setDisplay(Math.round(v)),
    });
    return () => controls.stop();
  }, [value, reduced]);

  return (
    <span className={className} aria-live="polite">
      {prefix}
      {formatNumber(display, locale)}
      {suffix}
    </span>
  );
}
