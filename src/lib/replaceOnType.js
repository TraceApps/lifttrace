/**
 * Svelte action: tap a number field, type, and the typing replaces what was
 * there, without selecting the old value first.
 *
 * Selecting on focus did the same job, but on Android any selection inside a
 * field brings up the system text toolbar (Translate, Cut, Copy) right over
 * the set row (issue #95). Here nothing is selected. Instead, the first
 * character typed after focusing takes the place of the whole value.
 *
 * It works on the input event, not by cancelling beforeinput, because Android
 * keyboards don't reliably let a page cancel their input. The listener runs in
 * the capture phase, so by the time the field's own handlers (bind:value,
 * on:input commits) read the value, it already holds just the new character.
 *
 * Anything other than typing a character (backspace, paste, moving the caret
 * with a second tap or the arrow keys) switches this off until the next focus,
 * so ordinary editing still works. While a replace is armed the field carries
 * the `replace-pending` class, so it can look different.
 */
const CARET_KEYS = new Set(['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End']);

export function replaceOnType(node) {
  let armed = false;
  const arm = () => { armed = true; node.classList.add('replace-pending'); };
  const disarm = () => { armed = false; node.classList.remove('replace-pending'); };

  const onFocus = () => arm();
  const onBlur = () => disarm();
  // A second tap on a field that already has focus places the caret on
  // purpose: from then on the user is editing, not replacing.
  const onPointerDown = () => { if (node.ownerDocument?.activeElement === node) disarm(); };
  const onKeyDown = (e) => { if (CARET_KEYS.has(e.key)) disarm(); };
  const onInput = (e) => {
    if (!armed) return;
    disarm();
    // Only a plain typed character replaces. Composition (some keyboards
    // assemble text before committing it) is left alone rather than risk
    // fighting the keyboard mid-word.
    if (e.inputType === 'insertText' && typeof e.data === 'string' && e.data !== '') {
      node.value = e.data;
    }
  };

  node.addEventListener('focus', onFocus);
  node.addEventListener('blur', onBlur);
  node.addEventListener('pointerdown', onPointerDown);
  node.addEventListener('keydown', onKeyDown);
  node.addEventListener('input', onInput, true);
  // Already focused when mounted (a field that appears and is focused in one step).
  if (node.ownerDocument?.activeElement === node) arm();

  return {
    destroy() {
      node.removeEventListener('focus', onFocus);
      node.removeEventListener('blur', onBlur);
      node.removeEventListener('pointerdown', onPointerDown);
      node.removeEventListener('keydown', onKeyDown);
      node.removeEventListener('input', onInput, true);
    },
  };
}
