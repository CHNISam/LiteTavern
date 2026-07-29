/**
 * Decorative hero artwork. Rings are drawn as true circles inside one tilted
 * group, so the orbiting dots stay exactly on their path while the group's
 * squash supplies the perspective. Motion is constant and slow, and it stops
 * entirely under prefers-reduced-motion.
 */
const RINGS = [
  { radius: 58, duration: 22, reverse: false, dot: 4.5 },
  { radius: 96, duration: 34, reverse: true, dot: 3.5 },
  { radius: 138, duration: 46, reverse: false, dot: 5.5 },
  { radius: 178, duration: 62, reverse: true, dot: 4 }
];

export function SupportOrbit() {
  return (
    <div className="support-orbit" aria-hidden="true">
      <svg viewBox="0 0 400 400" role="presentation" focusable="false">
        <defs>
          <radialGradient id="support-orbit-core">
            <stop offset="0%" stopColor="var(--pub-accent-bright)" stopOpacity="0.85" />
            <stop offset="60%" stopColor="var(--pub-accent)" stopOpacity="0.18" />
            <stop offset="100%" stopColor="var(--pub-accent)" stopOpacity="0" />
          </radialGradient>
        </defs>

        <g transform="translate(200 200) rotate(-16) scale(1 0.4) translate(-200 -200)">
          {RINGS.map((ring) => (
            <g key={ring.radius}>
              <circle
                className="support-orbit-ring"
                cx="200"
                cy="200"
                r={ring.radius}
                style={{ strokeDasharray: ring.reverse ? '3 7' : undefined }}
              />
              <g
                className="support-orbit-spin"
                style={{
                  animationDuration: `${ring.duration}s`,
                  animationDirection: ring.reverse ? 'reverse' : 'normal'
                }}
              >
                <circle
                  className="support-orbit-dot"
                  cx={200 + ring.radius}
                  cy="200"
                  r={ring.dot}
                />
              </g>
            </g>
          ))}
        </g>

        <circle className="support-orbit-core" cx="200" cy="200" r="120" />
        <path
          className="support-orbit-star"
          d="M200 128c6 40 26 60 66 66-40 6-60 26-66 66-6-40-26-60-66-66 40-6 60-26 66-66Z"
        />
      </svg>
    </div>
  );
}
