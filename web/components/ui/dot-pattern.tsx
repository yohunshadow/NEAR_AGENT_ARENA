"use client";

import { useId } from "react";

/**
 * Static dot field.
 * Adapted from Magic UI DotPattern (MIT): https://github.com/magicuidesign/magicui
 * Copyright (c) Magic UI. See ./MAGICUI-LICENSE.txt.
 * Glow is left off so the page keeps three motion motifs.
 */
export function DotPattern({ className = "" }: { className?: string }) {
  const id = `dots${useId().replace(/:/g, "")}`;
  return (
    <svg className={`dot-pattern ${className}`.trim()} aria-hidden="true">
      <defs>
        <pattern id={id} width="18" height="18" patternUnits="userSpaceOnUse">
          <circle cx="1" cy="1" r="0.85" fill="currentColor" />
        </pattern>
      </defs>
      <rect width="100%" height="100%" fill={`url(#${id})`} />
    </svg>
  );
}
