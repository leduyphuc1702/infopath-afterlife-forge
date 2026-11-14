// The page's own icons: small line drawings that take the colour of the text around them.
const SHAPES = {
  plus: <path d="M8 3v10M3 8h10" />,
  folder: <path d="M2 4.5a1 1 0 0 1 1-1h3.2l1.5 1.5H13a1 1 0 0 1 1 1V12a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1z" />,
  upload: <path d="M8 10.5V3M4.8 6.2 8 3l3.2 3.2M3 13h10" />,
  download: <path d="M8 2.5v7.5M4.8 7.2 8 10.4l3.2-3.2M3 13h10" />,
  trash: <path d="M3 4.5h10M6.5 4.5V3h3v1.5M4.5 4.5l.6 8.5h5.8l.6-8.5M6.8 7v4M9.2 7v4" />,
  close: <path d="M4 4l8 8M12 4l-8 8" />,
  chevron: <path d="M6 3.5 10.5 8 6 12.5" />,
  check: <path d="M3.5 8.3 6.6 11.2 12.5 4.8" />,
  arrow: <path d="M3 8h9.5M9 4.5 12.5 8 9 11.5" />,
  external: <path d="M9 3h4v4M13 3 7.5 8.5M11 9.5V13H3V5h3.5" />,
  copy: <><rect x="5.5" y="5.5" width="8" height="8" rx="1" /><path d="M10.5 5.5v-2a1 1 0 0 0-1-1h-6a1 1 0 0 0-1 1v6a1 1 0 0 0 1 1h2" /></>,
  search: <><circle cx="7" cy="7" r="4" /><path d="M10 10l3.2 3.2" /></>,
  flask: <path d="M6.5 2.5h3M7 2.5v3.8L3.6 12a1 1 0 0 0 .9 1.5h7a1 1 0 0 0 .9-1.5L9 6.3V2.5M5.3 10h5.4" />,
  swap: <path d="M3 5.5h9.5M10 3l2.5 2.5L10 8M13 10.5H3.5M6 8l-2.5 2.5L6 13" />,
  sliders: <><path d="M2.5 5h5M11.5 5h2M2.5 11h2M8.5 11h5" /><circle cx="9.5" cy="5" r="1.8" /><circle cx="6.5" cy="11" r="1.8" /></>,
  help: <><circle cx="8" cy="8" r="6" /><path d="M6.3 6.4a1.8 1.8 0 1 1 2.6 1.6c-.6.3-.9.7-.9 1.3" /><path d="M8 11.4v.1" /></>,
  warning: <><path d="M8 2.5 14 13H2z" /><path d="M8 6.6v3M8 11.3v.1" /></>,
  refresh: <path d="M13 8a5 5 0 1 1-1.6-3.7M13.2 2.6v2.9h-2.9" />,
};

export function Icon({ name, size = 16 }) {
  return (
    <svg
      className="icon" width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor"
      strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false"
    >
      {SHAPES[name]}
    </svg>
  );
}
