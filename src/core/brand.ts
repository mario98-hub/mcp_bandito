/**
 * Brand mark — the "bandito" raccoon. One source of truth, shared by:
 *  - the dashboard header (RACCOON_MARK, transparent, sits on the navy band),
 *  - the favicon and the MCP server icon (RACCOON_BADGE_SVG / ICON_DATA_URI),
 * so hosts show the raccoon instead of falling back to the deploy platform's
 * favicon (e.g. Render).
 *
 * Colours mirror the dashboard palette: band navy #14213d, paper #e9eae4,
 * accent yellow #f5c84c.
 */

// The raccoon face: ears (outer light + inner navy), head, bandit mask,
// accent eyes and snout. Drawn on a 64×64 grid, reused by both variants.
const BODY = `<path d="M20 23 C15 17 12 12 12 10 C16 10 23 13 27 18 Z" fill="#e9eae4"/>` +
  `<path d="M44 23 C49 17 52 12 52 10 C48 10 41 13 37 18 Z" fill="#e9eae4"/>` +
  `<path d="M20.5 20 C17.5 16 16 13.5 16 12.5 C18.5 12.8 22 14.8 24.5 18 Z" fill="#14213d"/>` +
  `<path d="M43.5 20 C46.5 16 48 13.5 48 12.5 C45.5 12.8 42 14.8 39.5 18 Z" fill="#14213d"/>` +
  `<path d="M32 15 C44.5 15 53 24 53 35 C53 47.5 43.5 56 32 56 C20.5 56 11 47.5 11 35 C11 24 19.5 15 32 15 Z" fill="#e9eae4"/>` +
  `<path d="M12.5 32.5 C16.5 26 24 25 29 29.2 C30.6 30.6 33.4 30.6 35 29.2 C40 25 47.5 26 51.5 32.5 C49 42.5 40 43.5 33 38.2 C32.4 37.7 31.6 37.7 31 38.2 C24 43.5 15 42.5 12.5 32.5 Z" fill="#14213d"/>` +
  `<circle cx="22.5" cy="33" r="4.3" fill="#f5c84c"/>` +
  `<circle cx="41.5" cy="33" r="4.3" fill="#f5c84c"/>` +
  `<circle cx="22.5" cy="33" r="1.95" fill="#14213d"/>` +
  `<circle cx="41.5" cy="33" r="1.95" fill="#14213d"/>` +
  `<path d="M32 40.5 L26.5 49 C29.2 52 34.8 52 37.5 49 Z" fill="#e9eae4"/>` +
  `<path d="M32 41.5 C34.2 41.5 36 43 36 44.6 C36 46.2 34.3 47.3 32 47.3 C29.7 47.3 28 46.2 28 44.6 C28 43 29.8 41.5 32 41.5 Z" fill="#14213d"/>`;

/** Face only, transparent background — for the header on the navy band. */
export const RACCOON_MARK = `<svg class="logo" viewBox="0 0 64 64" aria-hidden="true">${BODY}</svg>`;

/** Standalone badge (navy rounded square) — for favicons and the MCP server icon. */
export const RACCOON_BADGE_SVG =
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect x="2" y="2" width="60" height="60" rx="16" fill="#14213d"/>${BODY}</svg>`;

/** `data:` URI of the badge, for icon fields that expect a URL (MCP serverInfo, <link rel="icon">). */
export const RACCOON_ICON_DATA_URI = `data:image/svg+xml,${encodeURIComponent(RACCOON_BADGE_SVG)}`;
