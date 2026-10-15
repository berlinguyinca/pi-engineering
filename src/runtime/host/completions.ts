/**
 * Pi's slash-command argument completions are `AutocompleteItem` objects, not
 * strings: its matcher reads `item.value.startsWith(prefix)`, so a bare string
 * (value undefined) crashes the whole Pi process (issue #254).
 */

import type { AutocompleteItem } from "@earendil-works/pi-tui";

/**
 * Normalise a completion provider's result into Pi's item shape. Strings
 * become `{ value, label }`, item objects pass through unchanged, anything
 * else is dropped; an empty or non-array result is `null` (no suggestions).
 */
export function toAutocompleteItems(values: unknown): AutocompleteItem[] | null {
  if (!Array.isArray(values)) return null;
  const items: AutocompleteItem[] = [];
  for (const v of values) {
    if (typeof v === "string") items.push({ value: v, label: v });
    else if (v !== null && typeof v === "object" && typeof (v as { value?: unknown }).value === "string") {
      items.push(v as AutocompleteItem);
    }
  }
  return items.length > 0 ? items : null;
}
