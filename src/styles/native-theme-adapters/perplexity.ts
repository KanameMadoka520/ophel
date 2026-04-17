export const perplexityNativeThemeCss = `
/* Perplexity host theme adapter: keep the host page close to native,
 * but let Ophel's accent/background subtly tint key surfaces. */

html,
body,
main {
  background-color: color-mix(in srgb, var(--gh-primary) 1%, var(--gh-bg)) !important;
}

aside,
.group\\/sidebar,
nav:has(a[href^="/search/"]),
nav:has(a[href^="/page/"]) {
  background-color: color-mix(in srgb, var(--gh-primary) 2%, var(--gh-bg-secondary)) !important;
  border-color: color-mix(in srgb, var(--gh-primary) 12%, transparent) !important;
}

/* Conversation chips / cards / panels */
.bg-offset,
.bg-offsetPlus,
[class*="bg-offset"],
[class*="bg-offsetPlus"] {
  border-color: color-mix(in srgb, var(--gh-primary) 12%, transparent) !important;
}

/* Active top tabs, active sidebar items and similar selected states */
[role="tab"][aria-selected="true"],
button[aria-selected="true"],
a[aria-current="page"],
[data-state="active"] {
  color: var(--gh-primary) !important;
  background-color: color-mix(in srgb, var(--gh-primary) 10%, var(--gh-bg-secondary)) !important;
  border-color: color-mix(in srgb, var(--gh-primary) 20%, transparent) !important;
}

[role="tab"][aria-selected="true"] {
  box-shadow: inset 0 -2px 0 var(--gh-primary) !important;
}

/* Make icons follow the active foreground where possible */
[role="tab"][aria-selected="true"] svg,
button[aria-selected="true"] svg,
a[aria-current="page"] svg,
[data-state="active"] svg {
  color: var(--gh-primary) !important;
  stroke: currentColor !important;
}

/* Inputs and textareas keep the same minimal treatment as ChatGPT:
 * just tint borders/backgrounds, do not force all vectors. */
input,
textarea,
[role="textbox"],
[contenteditable="true"] {
  border-color: color-mix(in srgb, var(--gh-primary) 18%, transparent) !important;
}

main .mx-auto,
[role="tabpanel"] .mx-auto {
  background-color: color-mix(in srgb, var(--gh-primary) 1%, transparent) !important;
}
`
