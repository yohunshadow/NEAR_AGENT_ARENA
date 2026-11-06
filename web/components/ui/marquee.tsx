"use client";

import { Children, cloneElement, isValidElement, type ReactElement, type ReactNode } from "react";
import { useReducedMotion } from "motion/react";

/**
 * Horizontal marquee.
 * Adapted from Magic UI Marquee (MIT): https://github.com/magicuidesign/magicui
 * Copyright (c) Magic UI. See ./MAGICUI-LICENSE.txt.
 */
export function Marquee({
  children,
  duration = 40,
  repeat = 2,
  pauseOnHover = false,
  className = "",
}: {
  children: ReactNode;
  duration?: number;
  repeat?: number;
  pauseOnHover?: boolean;
  className?: string;
}) {
  const reduce = useReducedMotion() === true;
  const copies = reduce ? 1 : Math.max(1, repeat);
  return (
    <div
      className={`marquee${pauseOnHover ? " marquee-pause" : ""}${reduce ? " marquee-still" : ""} ${className}`.trim()}
      style={{ ["--duration" as string]: `${duration}s` }}
      aria-hidden="true"
    >
      {Array.from({ length: copies }, (_, copy) => (
        <div className="marquee-track" key={copy}>
          {copy === 0 ? children : keyedCopy(children, copy)}
        </div>
      ))}
    </div>
  );
}

function keyedCopy(children: ReactNode, copy: number): ReactNode {
  return Children.map(children, (child, index) => {
    if (!isValidElement(child)) return child;
    const element = child as ReactElement<{ children?: ReactNode }>;
    return cloneElement(element, { key: `${copy}-${String(element.key ?? index)}` });
  });
}
