import { describe, expect, it, vi } from "vitest";
import { openPrivateTokenSetupConsent } from "../src/setup-consent.ts";

// Only model the DOM operations used by the consent helper. These are unit
// tests for approval/event sequencing, not browser focus-trap or layout tests.
class FakeControl extends EventTarget {
  isConnected = true;
  focus = vi.fn();
}

class FakeDialog extends EventTarget {
  className = "";
  innerHTML = "";
  open = false;
  isConnected = false;
  attributes = new Map<string, string>();
  form = new FakeControl();
  heading = new FakeControl();
  allow = new FakeControl();
  deny = new FakeControl();
  setAttribute(name: string, value: string) { this.attributes.set(name, value); }
  querySelector(selector: string) {
    switch (selector) {
      case "form": return this.form;
      case "h2": return this.heading;
      case '[data-setup-choice="allow"]': return this.allow;
      case '[data-setup-choice="cancel"]': return this.deny;
      default: throw new Error(`Unexpected consent selector: ${selector}`);
    }
  }
  showModal = vi.fn(() => { this.open = true; });
  close = vi.fn(() => {
    this.open = false;
    // Deliberately synchronous to exercise re-entrant close handling.
    this.dispatchEvent(new Event("close"));
  });
  remove = vi.fn(() => { this.isConnected = false; });
}

function harness() {
  const previousFocus = new FakeControl();
  const dialogs: FakeDialog[] = [];
  const createElement = vi.fn((name: string) => {
    expect(name).toBe("dialog");
    const dialog = new FakeDialog();
    dialogs.push(dialog);
    return dialog;
  });
  const doc = {
    activeElement: previousFocus,
    createElement,
    body: { append: vi.fn((dialog: FakeDialog) => { dialog.isConnected = true; }) },
  } as unknown as Document;
  return { doc, dialogs, previousFocus, createElement };
}

describe("in-page private setup consent", () => {
  it("opens a named native modal and focuses its heading without scrolling", () => {
    const test = harness();
    const prompt = openPrivateTokenSetupConsent(test.doc);
    const dialog = test.dialogs[0]!;
    expect(dialog.showModal).toHaveBeenCalledOnce();
    expect(dialog.open).toBe(true);
    expect(dialog.attributes.get("aria-labelledby")).toBe("setup-consent-title");
    expect(dialog.attributes.get("aria-describedby")).toBe("setup-consent-description setup-consent-boundary");
    expect(dialog.innerHTML).toContain('id="setup-consent-title" tabindex="-1" autofocus');
    expect(dialog.innerHTML).toContain('id="setup-consent-description"');
    expect(dialog.innerHTML).toContain('id="setup-consent-boundary"');
    expect(dialog.innerHTML).toContain('type="button" data-setup-choice="cancel">Not now</button>');
    expect(dialog.innerHTML).toContain('type="button" data-setup-choice="allow">Allow setup and continue</button>');
    expect(dialog.heading.focus).toHaveBeenCalledWith({ preventScroll: true });
    prompt.cancel();
  });

  it("remains unresolved until a choice, and form submission cannot grant consent", async () => {
    const test = harness();
    const prompt = openPrivateTokenSetupConsent(test.doc);
    const observed = vi.fn();
    void prompt.result.then(observed);
    const submit = new Event("submit", { cancelable: true });
    test.dialogs[0]!.form.dispatchEvent(submit);
    await Promise.resolve();
    expect(submit.defaultPrevented).toBe(true);
    expect(observed).not.toHaveBeenCalled();
    prompt.cancel();
    await expect(prompt.result).resolves.toBe(false);
  });

  it("allows once despite the close event, later clicks, or cancellation", async () => {
    const test = harness();
    const prompt = openPrivateTokenSetupConsent(test.doc);
    const dialog = test.dialogs[0]!;
    dialog.allow.dispatchEvent(new Event("click"));
    dialog.deny.dispatchEvent(new Event("click"));
    prompt.cancel();
    await expect(prompt.result).resolves.toBe(true);
    expect(dialog.close).toHaveBeenCalledOnce();
    expect(dialog.remove).toHaveBeenCalledOnce();
    expect(test.previousFocus.focus).toHaveBeenCalledExactlyOnceWith({ preventScroll: true });
  });

  it.each(["deny", "escape", "close", "invalidate"] as const)("fails closed for %s and ignores later allow events", async (choice) => {
    const test = harness();
    const prompt = openPrivateTokenSetupConsent(test.doc);
    const dialog = test.dialogs[0]!;
    if (choice === "deny") dialog.deny.dispatchEvent(new Event("click"));
    if (choice === "escape") {
      const event = new Event("cancel", { cancelable: true });
      dialog.dispatchEvent(event);
      expect(event.defaultPrevented).toBe(true);
    }
    if (choice === "close") dialog.close();
    if (choice === "invalidate") prompt.cancel();
    dialog.allow.dispatchEvent(new Event("click"));
    prompt.cancel();
    await expect(prompt.result).resolves.toBe(false);
    expect(dialog.remove).toHaveBeenCalledOnce();
    expect(dialog.open).toBe(false);
    expect(test.previousFocus.focus).toHaveBeenCalledOnce();
  });

  it("does not focus a trigger that was removed during invalidation", async () => {
    const test = harness();
    const prompt = openPrivateTokenSetupConsent(test.doc);
    test.previousFocus.isConnected = false;
    prompt.cancel();
    await expect(prompt.result).resolves.toBe(false);
    expect(test.previousFocus.focus).not.toHaveBeenCalled();
  });

  it("requires a fresh decision on the next attempt", async () => {
    const test = harness();
    const first = openPrivateTokenSetupConsent(test.doc);
    const firstDialog = test.dialogs[0]!;
    firstDialog.allow.dispatchEvent(new Event("click"));
    await expect(first.result).resolves.toBe(true);

    const second = openPrivateTokenSetupConsent(test.doc);
    const observed = vi.fn();
    void second.result.then(observed);
    firstDialog.allow.dispatchEvent(new Event("click"));
    first.cancel();
    await Promise.resolve();
    expect(observed).not.toHaveBeenCalled();
    expect(test.dialogs[1]!.open).toBe(true);
    second.cancel();
    await expect(second.result).resolves.toBe(false);
  });

  it("removes the modal and fails closed when showModal is unavailable", () => {
    const test = harness();
    const dialog = new FakeDialog();
    dialog.showModal.mockImplementation(() => { throw new Error("modal unavailable"); });
    test.createElement.mockReturnValueOnce(dialog);
    expect(() => openPrivateTokenSetupConsent(test.doc)).toThrow(/could not open the setup approval/);
    expect(dialog.remove).toHaveBeenCalledOnce();
    expect(dialog.isConnected).toBe(false);
    expect(test.previousFocus.focus).toHaveBeenCalledOnce();
  });
});
