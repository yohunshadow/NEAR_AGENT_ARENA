"use client";

import type { CSSProperties } from "react";
import { motion, useReducedMotion } from "motion/react";

/**
 * Light traveling the border of one element.
 * Adapted from Magic UI BorderBeam (MIT): https://github.com/magicuidesign/magicui
 * Copyright (c) Magic UI. See ./MAGICUI-LICENSE.txt.
 * Upstream defaults are orange and purple. This arena uses NEAR mint only.
 */
export function BorderBeam({
  size = 220,
  duration = 7.5,
  delay = 0,
  colorFrom = "#00EC97",
  colorTo = "#F4FFF9",
  borderWidth = 2,
  reverse = false,
}: {
  size?: number;
  duration?: number;
  delay?: number;
  colorFrom?: string;
  colorTo?: string;
  borderWidth?: number;
  reverse?: boolean;
}) {
  const reduce = useReducedMotion() === true;
  if (reduce) return null;
  return (
    <div
      className="border-beam"
      aria-hidden="true"
      style={{ "--border-beam-width": `${borderWidth}px` } as CSSProperties}
    >
      <motion.span
        className="border-beam-light"
        style={
          {
            width: size,
            offsetPath: "rect(0 auto auto 0 round 2px)",
            offsetAnchor: "center",
            ["--beam-from" as string]: colorFrom,
            ["--beam-to" as string]: colorTo,
          } as CSSProperties
        }
        initial={{ offsetDistance: "0%" }}
        animate={{ offsetDistance: reverse ? ["100%", "0%"] : ["0%", "100%"] }}
        transition={{ repeat: Infinity, ease: "linear", duration, delay: -delay }}
      />
    </div>
  );
}
