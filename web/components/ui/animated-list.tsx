"use client";

import { AnimatePresence, motion, useReducedMotion } from "motion/react";

/**
 * Log lines that enter as they are written.
 * Adapted from Magic UI AnimatedList (MIT): https://github.com/magicuidesign/magicui
 * Copyright (c) Magic UI. See ./MAGICUI-LICENSE.txt.
 * The upstream list reveals items on a timer for demos. This one shows the real
 * log immediately and only fades a line in when it arrives. The spring pop is
 * dropped so the motion matches the hero entrance.
 */
export function AnimatedList({ items }: { items: string[] }) {
  const reduce = useReducedMotion() === true;
  const seen = new Map<string, number>();
  const rows = items.map((line) => {
    const count = seen.get(line) ?? 0;
    seen.set(line, count + 1);
    return { line, key: count === 0 ? line : `${line}#${count}` };
  });
  return (
    <ul className="log-list">
      <AnimatePresence initial={false}>
        {rows.map((row) => (
          <motion.li
            key={row.key}
            initial={reduce ? false : { opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={reduce ? undefined : { opacity: 0 }}
            transition={{ duration: 0.35, ease: [0.23, 1, 0.32, 1] }}
          >
            {row.line}
          </motion.li>
        ))}
      </AnimatePresence>
    </ul>
  );
}
