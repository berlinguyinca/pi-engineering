/**
 * Pi's own copy of which design rules are machine-checkable. Vendored from
 * berlinguyinca/autospec-design `rules.yaml` at
 * 167ed87abfac8bcda2044927e4d4077373b90db8 (id -> `check`).
 *
 * A passing entry in a design-gates report is credited ONLY for an id that this
 * table (or the operator's configured rules_file, which overrides it) says is
 * `auto`. An id Pi does not know is never credited: the report cannot promote a
 * vlm/review rule, or an invented one, to an executed pass.
 */
import type { RuleCheckClass } from "./designGate.ts";

export const DEFAULT_RULE_CLASSES: ReadonlyMap<string, RuleCheckClass> = new Map<string, RuleCheckClass>([
  ["design.tokens.no-raw-color", "auto"],
  ["design.tokens.spacing-on-scale", "auto"],
  ["design.tokens.zindex-on-scale", "auto"],
  ["design.tokens.font-from-tokens", "auto"],
  ["motion.reduced-motion-fallback", "auto"],
  ["motion.no-unstoppable-animation", "auto"],
  ["motion.duration-from-scale", "auto"],
  ["motion.happens-by-default", "auto"],
  ["motion.no-flash", "auto"],
  ["motion.coherent", "vlm"],
  ["device.zoom-not-blocked", "auto"],
  ["device.hover-has-equivalent", "auto"],
  ["device.reflow-at-320", "auto"],
  ["device.target-size", "auto"],
  ["device.safe-area", "vlm"],
  ["device.orientation", "auto"],
  ["composition.hierarchy", "vlm"],
  ["composition.states-complete", "vlm"],
  ["composition.density", "vlm"],
  ["a11y.alt-text-meaningful", "review"],
  ["a11y.link-text-meaningful", "review"],
  ["a11y.reading-order", "review"],
]);
