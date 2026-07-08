/**
 * Container-scoped scrolling for console focus movement.
 *
 * Never use Element.scrollIntoView() inside Console Mode: it scrolls every
 * overflowing ancestor — including `overflow: hidden` ones like the console
 * root — which drags the whole shell (status bar included) off screen.
 * This helper only ever moves the given container.
 *
 * The element must have the container as its offsetParent (give the
 * container `position: relative`).
 */
export function scrollToWithin(container, el, { margin = 24, behavior = 'smooth' } = {}) {
  if (!container || !el) return

  const top = el.offsetTop
  const bottom = top + el.offsetHeight
  const viewTop = container.scrollTop
  const viewBottom = viewTop + container.clientHeight

  // Already comfortably in view — don't move
  if (top >= viewTop + margin && bottom <= viewBottom - margin) return

  // Center the element for a stable, console-like reading position
  const target = top - (container.clientHeight - el.offsetHeight) / 2
  container.scrollTo({ top: Math.max(0, target), behavior })
}
