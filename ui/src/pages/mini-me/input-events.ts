/** Read the control that owns a Lit event listener, never a nested event target. */
export function miniMeInputValue(event: Event): string {
  const control = event.currentTarget;
  if (
    control instanceof HTMLInputElement ||
    control instanceof HTMLSelectElement ||
    control instanceof HTMLTextAreaElement
  ) {
    return control.value;
  }
  throw new Error("Mini Me input event has no form control");
}

export function miniMeInputChecked(event: Event): boolean {
  const control = event.currentTarget;
  if (control instanceof HTMLInputElement) {
    return control.checked;
  }
  throw new Error("Mini Me checkbox event has no input control");
}
