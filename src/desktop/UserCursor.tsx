import { useEffect, useRef } from "react";

export type CursorTarget = { x: number; y: number };

type UserCursorProps = {
  color: string;
  label: string;
  /** Normalized (0..1) target position relative to the cursor layer. */
  target: { readonly current: CursorTarget | null };
};

const ARROW_STIFFNESS = 420;
const ARROW_DAMPING = 38;
const PILL_STIFFNESS = 190;
const PILL_DAMPING = 26;
const MAX_FRAME_DELTA_S = 0.032;

type SpringAxis = { position: number; velocity: number };

function stepSpring(axis: SpringAxis, target: number, stiffness: number, damping: number, dt: number): void {
  const acceleration = stiffness * (target - axis.position) - damping * axis.velocity;
  axis.velocity += acceleration * dt;
  axis.position += axis.velocity * dt;
}

/**
 * Spring-tracked collaborative cursor: a pointer arrow that chases the target
 * position and a trailing name pill with softer physics, Figma-style.
 * Transforms are written straight to the DOM each frame, outside React.
 */
export function UserCursor({ color, label, target }: UserCursorProps) {
  const rootRef = useRef<HTMLDivElement | null>(null);
  const pillRef = useRef<HTMLDivElement | null>(null);
  const targetRef = useRef(target);
  targetRef.current = target;

  useEffect(() => {
    const root = rootRef.current;
    const pill = pillRef.current;
    if (!root || !pill) {
      return;
    }

    let frame = 0;
    let lastTime: number | null = null;
    let initialized = false;
    const arrowX: SpringAxis = { position: 0, velocity: 0 };
    const arrowY: SpringAxis = { position: 0, velocity: 0 };
    const pillX: SpringAxis = { position: 0, velocity: 0 };
    const pillY: SpringAxis = { position: 0, velocity: 0 };

    const tick = (time: number) => {
      frame = requestAnimationFrame(tick);

      const layer = root.parentElement;
      const normalized = targetRef.current.current;
      if (!layer || !normalized) {
        lastTime = time;
        return;
      }

      const targetX = normalized.x * layer.offsetWidth;
      const targetY = normalized.y * layer.offsetHeight;

      if (!initialized) {
        initialized = true;
        arrowX.position = targetX;
        arrowY.position = targetY;
        pillX.position = targetX;
        pillY.position = targetY;
      } else {
        const dt = Math.min((time - (lastTime ?? time)) / 1000, MAX_FRAME_DELTA_S);
        if (dt > 0) {
          stepSpring(arrowX, targetX, ARROW_STIFFNESS, ARROW_DAMPING, dt);
          stepSpring(arrowY, targetY, ARROW_STIFFNESS, ARROW_DAMPING, dt);
          stepSpring(pillX, arrowX.position, PILL_STIFFNESS, PILL_DAMPING, dt);
          stepSpring(pillY, arrowY.position, PILL_STIFFNESS, PILL_DAMPING, dt);
        }
      }

      lastTime = time;
      root.style.transform = `translate3d(${arrowX.position}px, ${arrowY.position}px, 0)`;
      pill.style.transform = `translate3d(${pillX.position - arrowX.position}px, ${pillY.position - arrowY.position}px, 0)`;
    };

    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, []);

  return (
    <div ref={rootRef} className="quickdrop-user-cursor">
      <svg width="22" height="22" viewBox="0 0 24 24" fill="none" aria-hidden="true">
        <path
          d="M5.2 2.8 19.6 11.2 12.9 12.9 9.3 18.9 5.2 2.8Z"
          fill={color}
          stroke="rgb(15 23 42 / 0.55)"
          strokeWidth="1.4"
          strokeLinejoin="round"
        />
      </svg>
      <div ref={pillRef} className="quickdrop-user-cursor-pill" style={{ backgroundColor: color }}>
        {label}
      </div>
    </div>
  );
}
