/**
 * Program actions shared by the Programs list and the program detail page.
 *
 * The preview pane on a wide screen needs the same actions the detail page
 * offers, and a second copy of them is how the Load Type chooser ended up
 * with three implementations. These are the pieces with no UI of their own,
 * so both callers can own their own menus and dialogs.
 */
import { LtApi } from './api.js';

/** "Push / Pull / Legs" to "Push / Pull / Legs (Copy 2)", skipping taken names. */
export function nextCopyName(sourceName, existingNames) {
  const base = String(sourceName || '').replace(/\s*\(Copy(?:\s+\d+)?\)\s*$/, '').trim() || 'Program';
  const taken = new Set(existingNames);
  if (!taken.has(`${base} (Copy)`)) return `${base} (Copy)`;
  let n = 2;
  while (taken.has(`${base} (Copy ${n})`)) n++;
  return `${base} (Copy ${n})`;
}

/**
 * Copy a program and every workout in it. `program` needs its templates
 * loaded; the caller fetches them, because the list page already has them
 * from the preview and the detail page from its own load.
 * Resolves to the new program.
 */
export async function duplicateProgram(program) {
  let existingNames = [];
  try { existingNames = (await LtApi.getPrograms()).map(p => p.name); } catch { /* names are a nicety */ }
  const copy = await LtApi.createProgram({
    name: nextCopyName(program.name, existingNames),
    description: program.description,
    goal: program.goal,
    duration_weeks: program.duration_weeks,
    advance_mode: program.advance_mode,
    on_complete: program.on_complete,
  });
  for (const t of program.templates || []) {
    await LtApi.createTemplate({
      program_id: copy.id,
      name: t.name,
      day_label: t.day_label,
      exercises: t.exercises,
    });
  }
  return copy;
}

/** Make this the active program, or clear whichever is active. */
export const setActive   = (id) => LtApi.setActiveProgram(id);
export const clearActive = ()   => LtApi.deactivateProgram();

/** Rename, returning whatever the server says the program now is. */
export async function renameProgram(id, name, current = {}) {
  const updated = await LtApi.updateProgram(id, { name });
  return updated?.id ? { ...current, ...updated } : { ...current, name };
}
