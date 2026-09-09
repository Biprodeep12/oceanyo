// Line icons, inline.
//
// Inline SVG rather than an icon package: there are eighteen of them, they
// need to inherit `currentColor` from the row or button that holds them, and
// an icon dependency is a build-time risk for a demo that must not fail to
// start.

type P = { className?: string };
const base = {
  viewBox: "0 0 24 24",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 1.7,
  strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const,
};

export const IconThermometer = (p: P) => (
  <svg {...base} {...p}>
    <path d="M14 14.8V4.5a2 2 0 1 0-4 0v10.3a4 4 0 1 0 4 0Z" />
    <path d="M12 9v6" />
  </svg>
);

export const IconSalinity = (p: P) => (
  <svg {...base} {...p}>
    <path d="M4 8c2.5-2 5.5-2 8 0s5.5 2 8 0" />
    <path d="M4 13c2.5-2 5.5-2 8 0s5.5 2 8 0" />
    <path d="M4 18c2.5-2 5.5-2 8 0s5.5 2 8 0" />
  </svg>
);

export const IconCurrent = (p: P) => (
  <svg {...base} {...p}>
    <path d="M3 9h11a3 3 0 1 0-3-3" />
    <path d="M3 15h14a3 3 0 1 1-3 3" />
  </svg>
);

export const IconChlorophyll = (p: P) => (
  <svg {...base} {...p}>
    <path d="M5 19c0-7 4-12 14-13 1 9-3 14-10 14H5Z" />
    <path d="M9 19c1-4 3-6 6-7.5" />
  </svg>
);

export const IconAnomaly = (p: P) => (
  <svg {...base} {...p}>
    <path d="M12 4.5 21 19H3L12 4.5Z" />
    <path d="M12 10v4" />
    <path d="M12 16.8h.01" />
  </svg>
);

export const IconFloat = (p: P) => (
  <svg {...base} {...p}>
    <circle cx="12" cy="8" r="3.2" />
    <path d="M12 11.2V21" />
    <path d="M8.5 21h7" />
  </svg>
);

export const IconVolume = (p: P) => (
  <svg {...base} {...p}>
    <path d="M12 3 21 7.5v9L12 21l-9-4.5v-9L12 3Z" />
    <path d="m3 7.5 9 4.5 9-4.5" />
    <path d="M12 12v9" />
  </svg>
);

export const IconPlane = (p: P) => (
  <svg {...base} {...p}>
    <path d="M12 5 22 10l-10 5-10-5 10-5Z" />
    <path d="M2 15l10 5 10-5" />
  </svg>
);

export const IconSection = (p: P) => (
  <svg {...base} {...p}>
    <path d="M3 6h18" />
    <path d="M6 6v13" />
    <path d="M18 6v13" />
    <path d="M6 19c4-3 8-3 12 0" />
  </svg>
);

export const IconIsosurface = (p: P) => (
  <svg {...base} {...p}>
    <ellipse cx="12" cy="12" rx="9" ry="4.5" />
    <path d="M3 12c0 4.5 4 7.5 9 7.5s9-3 9-7.5" />
    <path d="M12 4.5v15" />
  </svg>
);

export const IconDepth = (p: P) => (
  <svg {...base} {...p}>
    <path d="M12 3v18" />
    <path d="m7.5 16.5 4.5 4.5 4.5-4.5" />
    <path d="M4 6h16" />
  </svg>
);

export const IconSettings = (p: P) => (
  <svg {...base} {...p}>
    <circle cx="12" cy="12" r="3" />
    <path d="M19.4 15a1.6 1.6 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.6 1.6 0 0 0-1.8-.3 1.6 1.6 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1A1.6 1.6 0 0 0 9 19.4a1.6 1.6 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.6 1.6 0 0 0 .3-1.8 1.6 1.6 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1A1.6 1.6 0 0 0 4.6 9a1.6 1.6 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.6 1.6 0 0 0 1.8.3H9a1.6 1.6 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.6 1.6 0 0 0 1 1.5 1.6 1.6 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.6 1.6 0 0 0-.3 1.8V9a1.6 1.6 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.6 1.6 0 0 0-1.5 1Z" />
  </svg>
);

export const IconInfo = (p: P) => (
  <svg {...base} {...p}>
    <circle cx="12" cy="12" r="9" />
    <path d="M12 11v5" />
    <path d="M12 8h.01" />
  </svg>
);

export const IconRegion = (p: P) => (
  <svg {...base} {...p}>
    <circle cx="12" cy="12" r="7.5" />
    <path d="M12 1.8v3.4M12 18.8v3.4M1.8 12h3.4M18.8 12h3.4" />
    <circle cx="12" cy="12" r="1.6" />
  </svg>
);

export const IconPlay = (p: P) => (
  <svg viewBox="0 0 24 24" fill="currentColor" {...p}>
    <path d="M8 5.2v13.6L19 12 8 5.2Z" />
  </svg>
);

export const IconPause = (p: P) => (
  <svg viewBox="0 0 24 24" fill="currentColor" {...p}>
    <rect x="7" y="5" width="3.6" height="14" rx="1" />
    <rect x="13.4" y="5" width="3.6" height="14" rx="1" />
  </svg>
);

export const IconSkipEnd = (p: P) => (
  <svg viewBox="0 0 24 24" fill="currentColor" {...p}>
    <path d="M6 5.5v13L15 12 6 5.5Z" />
    <rect x="16" y="5.5" width="2.6" height="13" rx="1" />
  </svg>
);

export const IconChevronUp = (p: P) => (
  <svg {...base} {...p}>
    <path d="m6 15 6-6 6 6" />
  </svg>
);

export const IconChevronDown = (p: P) => (
  <svg {...base} {...p}>
    <path d="m6 9 6 6 6-6" />
  </svg>
);

export const IconPlus = (p: P) => (
  <svg {...base} {...p}>
    <path d="M12 5v14M5 12h14" />
  </svg>
);

export const IconMinus = (p: P) => (
  <svg {...base} {...p}>
    <path d="M5 12h14" />
  </svg>
);

export const IconClose = (p: P) => (
  <svg {...base} {...p}>
    <path d="M6 6l12 12M18 6 6 18" />
  </svg>
);

export const IconRaindrop = (p: P) => (
  <svg {...base} {...p}>
    <path d="M12 3.5s6 6.7 6 10.4a6 6 0 0 1-12 0C6 10.2 12 3.5 12 3.5Z" />
  </svg>
);
