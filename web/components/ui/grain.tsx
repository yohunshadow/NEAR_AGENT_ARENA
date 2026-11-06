/** Film grain overlay. Static turbulence, not an animation. */
export function Grain() {
  return (
    <svg className="grain" aria-hidden="true">
      <filter id="arena-grain">
        <feTurbulence type="fractalNoise" baseFrequency="0.8" numOctaves="2" stitchTiles="stitch" />
      </filter>
      <rect width="100%" height="100%" filter="url(#arena-grain)" />
    </svg>
  );
}
