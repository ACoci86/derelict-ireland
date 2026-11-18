// Interface icons, drawn in VectorCraft on a 24 px grid
// (source: ~/designs/derelict-icons/derelict-ireland-icons.vectorcraft).
// 1.75 px strokes with round caps and joins; they take the text colour.
export const ICON_PATHS = {
  reset: "M4 12 C4.003 15.816 6.701 19.099 10.445 19.841 C14.189 20.583 17.935 18.577 19.393 15.05 C20.851 11.523 19.615 7.458 16.44 5.339 C13.266 3.221 9.037 3.64 6.34 6.34 M9.84 6.34 L6.34 6.34 L6.34 2.84",
  move: "M12 3 L12 21 M3 12 L21 12 M9 6 L12 3 L15 6 M9 18 L12 21 L15 18 M6 9 L3 12 L6 15 M18 9 L21 12 L18 15",
  toMap: "M6 4 L18 4 M12 20 L12 9 M7.5 13.5 L12 9 L16.5 13.5",
  down: "M12 4.5 L12 19.5 M6.5 14 L12 19.5 L17.5 14",
  external: "M14 4 L20 4 L20 10 M20 4 L11 13 M18 14 L18 19 C18 19.552 17.552 20 17 20 L5 20 C4.448 20 4 19.552 4 19 L4 7 C4 6.448 4.448 6 5 6 L10 6",
  search: "M17 10.5 C17 14.09 14.09 17 10.5 17 C6.91 17 4 14.09 4 10.5 C4 6.91 6.91 4 10.5 4 C14.09 4 17 6.91 17 10.5 Z M15.1 15.1 L20.5 20.5",
  close: "M6.5 6.5 L17.5 17.5 M17.5 6.5 L6.5 17.5",
  chevron: "M6 9.5 L12 15.5 L18 9.5",
  pin: "M9 3.5 L15 3.5 M10 3.5 L10 9 L7 12.5 L17 12.5 L14 9 L14 3.5 M12 12.5 L12 20.5",
};

export function icon(name, { size = "1em", label = null } = {}) {
  const a11y = label ? `role="img" aria-label="${label}"` : 'aria-hidden="true"';
  return `<svg class="ico ico-${name}" width="${size}" height="${size}" viewBox="0 0 24 24" ${a11y} fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><path d="${ICON_PATHS[name]}"/></svg>`;
}
