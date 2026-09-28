// Chrome can report layout rectangles for controls inside closed details even
// though those controls cannot receive keyboard focus. Keep its first summary.
function disclosed(element) {
  for (let ancestor = element.parentElement; ancestor; ancestor = ancestor.parentElement) {
    if (!ancestor.matches('details:not([open])')) continue;
    const summary = Array.from(ancestor.children).find(child => child.tagName === 'SUMMARY');
    if (!summary?.contains(element)) return false;
  }
  return true;
}

export function tabbableElements(root) {
  if (!root) return [];
  return Array.from(root.querySelectorAll('a[href], area[href], button, input, textarea, select, summary, [tabindex], [contenteditable="true"]'))
    .filter(element => element.tabIndex >= 0 && !element.matches(':disabled, [type="hidden"]') && !element.closest('[inert]') && disclosed(element) && element.getClientRects().length > 0 && getComputedStyle(element).visibility === 'visible');
}
