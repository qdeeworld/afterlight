export interface SetupConsentPrompt {
  readonly result: Promise<boolean>;
  cancel(): void;
}

/** A per-attempt in-page choice, not a browser confirm that may be suppressed. */
export function openPrivateTokenSetupConsent(doc: Document = document): SetupConsentPrompt {
  const previousFocus = doc.activeElement;
  const dialog = doc.createElement("dialog");
  dialog.className = "setup-consent";
  dialog.setAttribute("aria-labelledby", "setup-consent-title");
  dialog.setAttribute("aria-describedby", "setup-consent-description setup-consent-boundary");
  // Static product copy only. Never insert wallet responses, keys or proof data.
  dialog.innerHTML = `<form>
    <h2 id="setup-consent-title" tabindex="-1" autofocus>Allow private token setup?</h2>
    <p id="setup-consent-description">Ready prepared one private token setup with this transaction. Your local key will approve the exact final package, limited to the reserve’s 1 STRK.</p>
    <p><strong>No extra deposit.</strong> The sponsor pays the claim fees. Do not Shield STRK or repeat private activation for this step.</p>
    <p id="setup-consent-boundary" class="warning">The setup is encrypted. Afterlight cannot verify whether it belongs to this STRK destination. You are allowing this one bounded setup, not any extra transfer.</p>
    <p>This is Afterlight’s approval, separate from Ready’s proof preparation. No claim has been signed or submitted yet.</p>
    <div class="button-row">
      <button class="button secondary" type="button" data-setup-choice="cancel">Not now</button>
      <button class="button primary" type="button" data-setup-choice="allow">Allow setup and continue</button>
    </div>
  </form>`;
  let settled = false;
  let resolveResult!: (allowed: boolean) => void;
  const result = new Promise<boolean>((resolve) => { resolveResult = resolve; });
  function finish(allowed: boolean): void {
    if (settled) return;
    settled = true;
    if (dialog.open) dialog.close();
    dialog.remove();
    if (previousFocus?.isConnected && "focus" in previousFocus) {
      (previousFocus as HTMLElement).focus({ preventScroll: true });
    }
    resolveResult(allowed);
  }
  dialog.querySelector("form")!.addEventListener("submit", (event) => event.preventDefault());
  dialog.querySelector('[data-setup-choice="allow"]')!.addEventListener("click", () => finish(true));
  dialog.querySelector('[data-setup-choice="cancel"]')!.addEventListener("click", () => finish(false));
  dialog.addEventListener("cancel", (event) => { event.preventDefault(); finish(false); });
  // Closing or invalidating the dialog can never count as consent.
  dialog.addEventListener("close", () => finish(false));
  doc.body.append(dialog);
  try {
    dialog.showModal();
    dialog.querySelector<HTMLElement>("h2")!.focus({ preventScroll: true });
    // Native autofocus can scroll an overflowing dialog toward its controls.
    // Start with the heading/disclosure visible, including on narrow screens.
    dialog.scrollTop = 0;
  } catch {
    finish(false);
    throw new Error("Afterlight could not open the setup approval. No claim was signed or submitted. Keep this tab open and report this error.");
  }
  return { result, cancel: () => finish(false) };
}
