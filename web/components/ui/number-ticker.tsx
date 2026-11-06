"use client";

import { motion, useReducedMotion } from "motion/react";

/**
 * In-place numeral ticker for a live clock and pool.
 * Magic UI NumberTicker (MIT) springs a value once when it enters the viewport:
 * https://github.com/magicuidesign/magicui
 * A one-shot count would restart the round clock, so this keeps their motion
 * dependency and rolls only the digit that changed. See ./MAGICUI-LICENSE.txt.
 */
export function NumberTicker({ value, className = "" }: { value: string; className?: string }) {
  const reduce = useReducedMotion() === true;
  if (reduce) {
    return <span className={`ticker ${className}`.trim()}>{value}</span>;
  }
  return (
    <span className={`ticker ${className}`.trim()} aria-hidden="true">
      {value.split("").map((char, index) =>
        /\d/.test(char) ? (
          <span className="ticker-window" key={`${index}-d`}>
            <motion.span
              className="ticker-strip"
              initial={false}
              animate={{ y: `${-Number(char)}em` }}
              transition={{ duration: 0.45, ease: [0.23, 1, 0.32, 1] }}
            >
              {DIGITS.map((digit) => (
                <span key={digit}>{digit}</span>
              ))}
            </motion.span>
          </span>
        ) : (
          <span className="ticker-char" key={`${index}-${char}`}>
            {char}
          </span>
        ),
      )}
    </span>
  );
}

const DIGITS = ["0", "1", "2", "3", "4", "5", "6", "7", "8", "9"];
