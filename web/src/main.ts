import "./style.css";
import { num } from "starknet";
import { RELAYER_URL, STRK } from "./config.ts";
import { assertMainnet, readLiability, readVault } from "./chain.ts";
import { parseInvitation, stateName, type RecoveryInvitation, type Role, type VaultSnapshot, type WalletStatus } from "./model.ts";
import { connectReady, detectReady, type ReadySession } from "./wallet.ts";
import { ExitSubmissionError, exportKey, fundRecoveryReserve, generateKey, hasPendingCheckpointReconciliation, prepareExitPackage, relayControl, restoreKey, submitExitPackage } from "./operations.ts";
import type { LocalStarkKey } from "../../client/src/keys.ts";

let role: Role = (new URL(location.href).searchParams.get("role") === "successor") ? "successor" : "owner";
let walletStatus: WalletStatus = "checking";
let ready: ReadySession | undefined;
let privateBalance: bigint | undefined;
let applicationKey: LocalStarkKey | undefined;
let successorPublicKey = "";
let invitationText = localStorage.getItem("afterlight:invitation:v1") ?? "";
let vault: VaultSnapshot | undefined;
let notice = "Loading the live Starknet Mainnet product…";
let busy = false;
let transactionHash = "";
let costAcknowledged = false;
type PendingExit = Readonly<{
  action: "CANCEL_REFUND" | "CLAIM";
  vaultId: string;
  exitPackage: Readonly<Record<string, unknown>>;
  balanceBefore: string;
}>;

const PENDING_EXIT_STORAGE_KEY = "afterlight:pending-exit:v1";

function restorePendingExit(): PendingExit | undefined {
  try {
    const value = JSON.parse(sessionStorage.getItem(PENDING_EXIT_STORAGE_KEY) ?? "null") as Partial<PendingExit> | null;
    if (
      value === null ||
      (value.action !== "CANCEL_REFUND" && value.action !== "CLAIM") ||
      !/^0x[0-9a-f]{1,64}$/i.test(value.vaultId ?? "") ||
      typeof value.exitPackage !== "object" ||
      value.exitPackage === null ||
      !/^[0-9]+$/.test(value.balanceBefore ?? "")
    ) return undefined;
    return value as PendingExit;
  } catch {
    return undefined;
  }
}

let pendingExit = restorePendingExit();

function retainPendingExit(value: PendingExit | undefined): void {
  pendingExit = value;
  if (value === undefined) sessionStorage.removeItem(PENDING_EXIT_STORAGE_KEY);
  else sessionStorage.setItem(PENDING_EXIT_STORAGE_KEY, JSON.stringify(value));
}
let exitCapacity: "checking" | "ready" | "exhausted" | "unknown" = "checking";
let fundingCapacity: "checking" | "ready" | "exhausted" | "unknown" = "checking";
let reserveMode: "NORMAL" | "FAST_DEMO" = "NORMAL";

async function refreshSponsorCapacity(): Promise<void> {
  const response = await fetch(`${RELAYER_URL}/health`, {
    cache: "no-store",
    credentials: "omit",
    referrerPolicy: "no-referrer",
  });
  const body = await response.json() as {
    submission?: string;
    claimCapacity?: { status?: string; fundingStatus?: string };
  };
  if (!response.ok || body.submission !== "enabled" || body.claimCapacity === undefined) {
    throw new Error("The neutral sponsor capacity could not be verified. No wallet request was made.");
  }
  exitCapacity = body.claimCapacity.status === "ready"
    ? "ready"
    : body.claimCapacity.status === "exhausted" ? "exhausted" : "unknown";
  fundingCapacity = body.claimCapacity.fundingStatus === "ready"
    ? "ready"
    : body.claimCapacity.fundingStatus === "exhausted" ? "exhausted" : "unknown";
}

const appRoot = document.querySelector<HTMLDivElement>("#app");
if (!appRoot) throw new Error("Afterlight app root is missing.");
const app: HTMLDivElement = appRoot;

function escapeHtml(value: string): string {
  return value.replace(/[&<>'"]/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" })[character] ?? character);
}

function short(value: string): string {
  return value.length > 18 ? `${value.slice(0, 10)}…${value.slice(-6)}` : value;
}

function strk(value: bigint): string {
  const whole = value / 10n ** 18n;
  const fraction = (value % 10n ** 18n).toString().padStart(18, "0").replace(/0+$/, "");
  return `${whole}${fraction ? `.${fraction.slice(0, 4)}` : ""} STRK`;
}

function assertInvitationMatchesVault(invitation: RecoveryInvitation, snapshot: VaultSnapshot): void {
  const mode = invitation.mode === "NORMAL" ? "0" : "1";
  for (const [label, observed, expected] of [
    ["owner key", snapshot.ownerKey, invitation.ownerKey],
    ["successor key", snapshot.successorKey, invitation.successorKey],
    ["token", snapshot.token, STRK],
    ["amount", snapshot.amount, 10n ** 18n],
    ["mode", snapshot.mode, mode],
    ["inactivity", snapshot.inactivitySeconds, invitation.inactivitySeconds],
    ["grace", snapshot.graceSeconds, invitation.graceSeconds],
  ] as const) {
    if (num.toHex(BigInt(observed)) !== num.toHex(BigInt(expected))) throw new Error(`Invitation ${label} does not match Mainnet state.`);
  }
}

function progressStep(label: string, detail: string, complete: boolean, current: boolean): string {
  const state = complete ? "complete" : current ? "current" : "upcoming";
  return `<li data-state="${state}"><span aria-hidden="true">${complete ? "✓" : ""}</span><div><strong>${label}</strong><small>${detail}</small></div></li>`;
}

function journeyProgress(): string {
  const invitationValid = parseInvitation(invitationText).valid;
  const hasWallet = walletStatus === "connected";
  const hasKey = Boolean(applicationKey);
  if (role === "owner") {
    return `<ol class="journey-progress" aria-label="Owner journey progress">
      ${progressStep("Connect", "Ready X", hasWallet, !hasWallet)}
      ${progressStep("Set up", "Keys and terms", invitationValid, hasWallet && !invitationValid)}
      ${progressStep("Protect", "Fund and stay active", vault?.exists === true, invitationValid)}
    </ol>`;
  }
  return `<ol class="journey-progress" aria-label="Successor journey progress">
    ${progressStep("Prepare", "Your recovery key", hasKey, !hasKey)}
    ${progressStep("Verify", "Recovery invitation", invitationValid, hasKey && !invitationValid)}
    ${progressStep("Recover", "Live vault and claim", vault?.exists === true, invitationValid)}
  </ol>`;
}

function download(filename: string, contents: string): void {
  const blob = new Blob([`${contents}\n`], { type: "application/json" });
  const link = document.createElement("a");
  link.href = URL.createObjectURL(blob);
  link.download = filename;
  link.click();
  window.setTimeout(() => URL.revokeObjectURL(link.href), 0);
}

function walletCopy(): string {
  if (walletStatus === "checking") return "Checking for Ready X…";
  if (walletStatus === "missing") return "Ready X was not found in this browser profile.";
  if (walletStatus === "available") return "Ready X is available. Connecting spends nothing.";
  if (walletStatus === "connecting") return "Waiting for Ready X authorization…";
  if (walletStatus === "wrong-network") return "Switch Ready X to Starknet Mainnet.";
  return `${short(ready?.address ?? "")} · ${privateBalance === undefined ? "balance unread" : strk(privateBalance)} private`;
}

function keyPanel(person: "owner" | "successor"): string {
  const isCurrent = role === person;
  return `<section class="key-panel"><div class="section-heading"><span class="step-number">${person === "owner" ? "02" : "01"}</span>
    <div><strong>${person === "owner" ? "Create your owner control key" : "Prepare your successor key"}</strong><p>Generated locally for one vault. The secret never reaches the relayer or Ready X.</p></div></div>
    ${applicationKey && isCurrent ? `<code>${escapeHtml(applicationKey.publicKey)}</code><div class="button-row"><button class="button secondary" data-action="copy-key">Copy public key</button><button class="button secondary" data-action="download-key">Download secret backup</button></div>` : `<button class="button secondary" data-action="generate-key">Generate ${person} key locally</button>`}
    <details class="restore-key"><summary>Already have a key backup?</summary><label class="full-field"><span>Restore ${person} key backup</span><input data-key-file type="file" accept="application/json,.json" /><small>Read only on this device. Never share this file.</small></label></details>
  </section>`;
}

function walletRow(): string {
  return `<section class="wallet-row" data-status="${walletStatus}"><div class="section-heading"><span class="step-number">01</span><div><strong>Connect Ready X</strong><span>${escapeHtml(walletCopy())}</span></div></div><button class="button secondary" data-action="connect" ${busy ? "disabled" : ""}>${walletStatus === "connected" ? "Refresh balance" : "Connect"}</button></section>`;
}

function canFundReserve(): boolean {
  return fundingCapacity === "ready"
    && walletStatus === "connected"
    && privateBalance !== undefined
    && privateBalance >= 7n * 10n ** 18n
    && applicationKey !== undefined
    && /^0x[0-9a-f]{1,64}$/i.test(successorPublicKey)
    && costAcknowledged;
}

function ownerView(): string {
  const invitation = parseInvitation(invitationText);
  const canFund = canFundReserve();
  const liveControls = invitation.valid && vault?.exists;
  return `<section class="journey" data-role-view="owner" aria-labelledby="owner-heading">
    <div class="journey-heading"><div><p class="eyebrow">Owner · live on Mainnet</p><h2 id="owner-heading">Create a recovery reserve</h2></div><span class="journey-mode">${reserveMode === "NORMAL" ? "Long-term reserve" : "Recovery Drill"} · 1 STRK</span></div>
    <p class="lede">Privately set aside 1 STRK. Heartbeat while active and veto a recovery request during grace.</p>
    ${journeyProgress()}
    ${walletRow()}
    ${keyPanel("owner")}
    <form id="reserve-form" class="setup-form"><div class="section-heading"><span class="step-number">03</span><div><strong>Choose the recovery terms</strong><p>Both modes use fixed, contract-enforced terms.</p></div></div>
      <fieldset><legend>Choose a timing mode</legend><label class="choice ${reserveMode === "NORMAL" ? "selected" : ""}"><input type="radio" name="reserve-mode" value="NORMAL" ${reserveMode === "NORMAL" ? "checked" : ""} /><span><strong>30 days + 7 days</strong><small>Long-term inactivity and grace</small></span></label><label class="choice ${reserveMode === "FAST_DEMO" ? "selected" : ""}"><input type="radio" name="reserve-mode" value="FAST_DEMO" ${reserveMode === "FAST_DEMO" ? "checked" : ""} /><span><strong>5 min + 5 min</strong><small>Clearly labelled Recovery Drill</small></span></label></fieldset>
      <label class="full-field"><span>Designated successor public key</span><input name="successor-key" autocomplete="off" spellcheck="false" placeholder="0x…" value="${escapeHtml(successorPublicKey)}" /><small>The successor must generate this independently. Do not accept their secret.</small></label>
      <aside class="cost-note"><strong>Exact private-wallet consequence</strong><p>Creating this reserve uses 1 STRK as recoverable principal plus Ready’s separate 6 STRK private-action fee. You will confirm one Ready X transaction. Neutral exit sponsorship is capacity-limited and rechecked later; recovery or cancellation waits if capacity must be restored.</p></aside>
      <label class="ack"><input name="cost-ack" type="checkbox" ${costAcknowledged ? "checked" : ""} /><span>I understand this action uses 7 STRK from my shielded balance.</span></label>
      <button class="button primary" type="submit" ${canFund ? "" : "disabled"}>${fundingCapacity === "exhausted" ? "New reserves temporarily paused" : fundingCapacity === "checking" ? "Checking recovery capacity" : fundingCapacity === "unknown" ? "Recovery capacity unavailable" : !costAcknowledged ? "Confirm the 7 STRK cost to continue" : "Create and privately fund reserve"}</button>
      ${fundingCapacity === "exhausted" ? `<p class="error">The supported route already has an outstanding reserve or private-exit capacity needs replenishment. New funding stays paused; existing vault controls remain available.</p>` : fundingCapacity === "unknown" ? `<p class="error">Recovery capacity could not be verified. Funding stays disabled to protect users.</p>` : ""}
      ${privateBalance !== undefined && privateBalance < 7n * 10n ** 18n ? `<p class="error">At least 7 private STRK is required for this action.</p>` : ""}
    </form>
    ${invitation.valid ? controlPanel(invitation.invitation, liveControls ? vault : undefined) : ""}
  </section>`;
}

function successorView(): string {
  const parsed = parseInvitation(invitationText);
  return `<section class="journey" data-role-view="successor" aria-labelledby="successor-heading">
    <div class="journey-heading"><div><p class="eyebrow">Successor · live on Mainnet</p><h2 id="successor-heading">Recover a reserve privately</h2></div><span class="journey-mode">Designated key only</span></div>
    <p class="lede">Generate your own per-vault key, import the invitation, and request only after authenticated inactivity.</p>
    ${journeyProgress()}
    ${keyPanel("successor")}
    ${invitationPanel(parsed)}
    ${parsed.valid ? `${walletRow()}${controlPanel(parsed.invitation, vault)}` : ""}
  </section>`;
}

function invitationPanel(parsed: ReturnType<typeof parseInvitation>): string {
  const editor = `<label class="full-field"><span>Recovery invitation</span><textarea name="invitation" rows="8" placeholder="Paste Afterlight invitation JSON">${escapeHtml(invitationText)}</textarea><small>Checked locally before any wallet or relay action.</small></label><button class="button secondary" data-action="validate-invitation">Verify invitation</button>`;
  if (!parsed.valid) {
    return `<section class="invitation-panel"><div class="section-heading"><span class="step-number">02</span><div><strong>Verify the recovery invitation</strong><p>Paste the package received from the owner.</p></div></div>${editor}<div class="invitation-result" data-valid="false"><strong>Waiting for a valid invitation</strong><p>${escapeHtml(parsed.reason)}</p></div></section>`;
  }
  const timing = parsed.invitation.mode === "NORMAL" ? "30 days + 7 days" : "5 + 5 min drill";
  return `<section class="invitation-panel verified"><div class="section-heading"><span class="step-number">02</span><div><strong>Invitation verified</strong><p>Contract, designated key and recovery terms match Afterlight Mainnet.</p></div><span class="verified-mark">Verified</span></div><div class="invitation-facts"><span><small>Vault</small><strong>${short(parsed.invitation.vaultId)}</strong></span><span><small>Reserve</small><strong>1 STRK</strong></span><span><small>Timing</small><strong>${timing}</strong></span></div><details class="invitation-editor"><summary>Replace invitation</summary>${editor}</details></section>`;
}

function controlPanel(invitation: RecoveryInvitation, snapshot?: VaultSnapshot): string {
  if (!snapshot) return `<section class="control-panel next-action"><div class="section-heading"><span class="step-number">04</span><div><strong>Read the live reserve</strong><p>Confirm the current Mainnet state before taking action.</p></div></div><button class="button primary" data-action="load-vault" ${busy ? "disabled" : ""}>Read live vault state</button></section>`;
  const current = stateName(snapshot.state);
  const now = Math.floor(Date.now() / 1000);
  const inactiveAt = Number(snapshot.lastHeartbeat) + Number(snapshot.inactivitySeconds);
  const requestReady = current === "ACTIVE" && now >= inactiveAt;
  const claimReady = current === "GRACE" && now >= Number(snapshot.claimAfter);
  const timingLabel = current === "GRACE" ? "Claim after" : current === "ACTIVE" ? "Inactive after" : "Settlement";
  const timingValue = current === "GRACE"
    ? new Date(Number(snapshot.claimAfter) * 1000).toLocaleTimeString()
    : current === "ACTIVE"
      ? new Date(inactiveAt * 1000).toLocaleTimeString()
      : current;
  const stateCopy = current === "ACTIVE" ? "Protected and listening for an authenticated heartbeat." : current === "GRACE" ? "Recovery requested. The owner can still veto before settlement." : current === "CLAIMED" ? "Recovery completed exactly once to the designated private note." : "The reserve returned privately to its owner.";
  return `<section class="control-panel live-state" data-vault-state="${current}"><div class="control-heading"><div><span class="state-chip">${current}</span><p>${stateCopy}</p><small>Vault ${short(invitation.vaultId)} · epoch ${snapshot.epoch}</small></div><button class="text-button" data-action="load-vault">Refresh state</button></div>
    <div class="metrics"><div><span>Reserve</span><strong>1 STRK</strong></div><div><span>${timingLabel}</span><strong>${timingValue}</strong></div></div>
    ${role === "owner" && current === "ACTIVE" ? `<button class="button primary" data-control="HEARTBEAT" ${!applicationKey || busy ? "disabled" : ""}>Send private heartbeat</button><button class="button danger" data-action="cancel-refund" ${!applicationKey || !ready || (exitCapacity !== "ready" && pendingExit?.action !== "CANCEL_REFUND") || busy ? "disabled" : ""}>${pendingExit?.action === "CANCEL_REFUND" ? "Reconcile pending cancellation" : "Cancel and return 1 STRK privately"}</button>${exitCapacity !== "ready" && pendingExit?.action !== "CANCEL_REFUND" ? `<p class="error">Private cancellation is paused until sponsor exit capacity is restored.</p>` : ""}` : ""}
    ${role === "owner" && current === "GRACE" ? `<button class="button primary" data-control="VETO" ${!applicationKey || busy ? "disabled" : ""}>Veto recovery</button>` : ""}
    ${role === "successor" && current === "ACTIVE" ? `<button class="button primary" data-control="REQUEST" ${!applicationKey || !requestReady || busy ? "disabled" : ""}>${requestReady ? "Request recovery" : "Request opens after inactivity"}</button>` : ""}
    ${role === "successor" && current === "GRACE" ? `<button class="button primary" ${claimReady && ready && applicationKey && (exitCapacity === "ready" || pendingExit?.action === "CLAIM") ? "" : "disabled"} data-action="claim">${pendingExit?.action === "CLAIM" ? "Reconcile pending claim" : exitCapacity === "exhausted" ? "Private recovery temporarily paused" : claimReady ? "Recover 1 STRK privately" : "Grace period is active"}</button>${exitCapacity !== "ready" && claimReady && pendingExit?.action !== "CLAIM" ? `<p class="error">Private recovery is paused until sponsor exit capacity is restored.</p>` : ""}` : ""}
    <p class="action-help">Heartbeat, request and veto use your local signature through the neutral relayer. The Ready wallet address is not sent.</p>
  </section>`;
}

function statusPanel(): string {
  const parsed = parseInvitation(invitationText);
  const current = vault?.exists ? stateName(vault.state) : "Not loaded";
  const headline = current === "CLAIMED" ? "Recovery complete" : current === "CANCELLED" ? "Reserve returned" : current === "GRACE" ? "Owner still has control" : current === "ACTIVE" ? "Reserve protected" : "Private by design";
  return `<aside class="status-panel"><p class="status-label">${current === "Not loaded" ? "What Afterlight protects" : "Live outcome"}</p><strong>${headline}</strong><p>${parsed.valid ? `${current} · ${short(parsed.invitation.vaultId)}` : "Create or import a reserve to read its live state."}</p>
    <div class="trace"><div><span>✓</span><p><strong>Funding relationship</strong><small>Unlinked by STRK20</small></p></div><div><span>✓</span><p><strong>Heartbeat and veto wallet</strong><small>Hidden behind signed neutral relay</small></p></div><div><span>✓</span><p><strong>Recovery destination</strong><small>Bound to one exact private note</small></p></div><div class="public"><span>○</span><p><strong>Timing and denomination</strong><small>Remain public</small></p></div></div>
    ${transactionHash ? `<a class="receipt" href="https://voyager.online/tx/${escapeHtml(transactionHash)}" target="_blank" rel="noreferrer">View latest Mainnet receipt ↗</a>` : ""}
    <details><summary>Truthful privacy boundary</summary><p>The contract, token, fixed denomination, application public keys, timing and state changes remain public. Ready wallet relationships and later private-note activity stay unlinked.</p></details></aside>`;
}

function render(): void {
  app.innerHTML = `<header class="site-header"><a class="brand" href="/"><span aria-hidden="true">◐</span>Afterlight</a><div class="network"><span aria-hidden="true"></span>Live on Starknet Mainnet</div></header>
  <main id="main"><section class="intro"><div><p class="kicker">Private recovery, under your control</p><h1>A private reserve for the person you trust.</h1><p>Keep the relationship unlinked. Heartbeat while active, veto during grace, and let only the designated successor key authorize private recovery.</p></div><div class="promise"><span>01</span><p><strong>Fund privately</strong><small>The owner-to-vault link stays unlinked.</small></p><span>02</span><p><strong>Stay in control</strong><small>Heartbeat or veto through a neutral relay.</small></p><span>03</span><p><strong>Recover exactly once</strong><small>One designated key. One exact private note.</small></p></div></section>
  <nav class="role-tabs" aria-label="Choose your role"><button data-role="owner" aria-current="${role === "owner" ? "page" : "false"}">I’m the owner</button><button data-role="successor" aria-current="${role === "successor" ? "page" : "false"}">I’m the successor</button></nav>
  <div class="activity-banner" role="status" aria-live="polite" data-busy="${busy}"><span aria-hidden="true">${busy ? "…" : "●"}</span><p>${busy ? "Working · " : ""}${escapeHtml(notice)}</p></div>
  <div class="content-grid">${role === "owner" ? ownerView() : successorView()}${statusPanel()}</div></main>
  <footer><span>Afterlight is a recovery tool, not legal inheritance automation.</span><a href="https://github.com/dolepee/afterlight">Open-source contract</a></footer>
  <dialog id="cancel-dialog" aria-labelledby="cancel-title" aria-describedby="cancel-description"><form method="dialog"><p class="eyebrow">Private return</p><h2 id="cancel-title">Cancel this reserve?</h2><p id="cancel-description">Its 1 STRK principal returns to this Ready X private balance. The reserve cannot be recovered afterward.</p><div class="button-row"><button class="button secondary" type="button" data-action="dismiss-cancel">Keep reserve active</button><button class="button danger" type="button" data-action="confirm-cancel">Cancel and return 1 STRK</button></div></form></dialog>`;
  bindEvents();
}

function fail(error: unknown): void {
  notice = error instanceof Error ? error.message : String(error);
  busy = false;
  render();
}

async function run(action: () => Promise<void>): Promise<void> {
  if (busy) return;
  busy = true;
  render();
  try { await action(); } catch (error) { fail(error); return; }
  busy = false;
  render();
}

function bindEvents(): void {
  document.querySelectorAll<HTMLButtonElement>("[data-role]").forEach((button) => button.addEventListener("click", () => {
    role = button.dataset.role === "successor" ? "successor" : "owner";
    applicationKey?.destroy();
    applicationKey = undefined;
    vault = undefined;
    history.replaceState(null, "", `/?role=${role}`);
    render();
  }));
  document.querySelector<HTMLButtonElement>("[data-action=connect]")?.addEventListener("click", () => void run(async () => {
    if (!ready) {
      walletStatus = "connecting";
      render();
      ready = await connectReady((await import("./chain.ts")).provider, () => {
        ready?.disconnect(); ready = undefined; privateBalance = undefined; walletStatus = "available"; notice = "Ready account or network changed. Reconnect to continue."; render();
      });
    }
    privateBalance = await ready.balance(STRK);
    walletStatus = "connected";
    notice = `Ready X connected. Private balance: ${strk(privateBalance)}.`;
  }));
  document.querySelector<HTMLButtonElement>("[data-action=generate-key]")?.addEventListener("click", () => {
    applicationKey?.destroy();
    applicationKey = generateKey();
    if (role === "successor") successorPublicKey = applicationKey.publicKey;
    notice = `${role === "owner" ? "Owner" : "Successor"} key generated locally. Download its secret backup before leaving this page.`;
    render();
  });
  document.querySelector<HTMLButtonElement>("[data-action=copy-key]")?.addEventListener("click", () => void run(async () => {
    if (!applicationKey) throw new Error("Generate or restore a key first.");
    await navigator.clipboard.writeText(applicationKey.publicKey);
    notice = "Public key copied. Sharing the public key is safe; never share the backup file.";
  }));
  document.querySelector<HTMLButtonElement>("[data-action=download-key]")?.addEventListener("click", () => {
    if (!applicationKey) return;
    download(`afterlight-${role}-key-${applicationKey.publicKey.slice(2, 10)}.json`, exportKey(applicationKey));
    notice = "Secret backup downloaded. Store it safely and never send it to anyone.";
    render();
  });
  document.querySelector<HTMLInputElement>("[data-key-file]")?.addEventListener("change", (event) => void run(async () => {
    const file = (event.currentTarget as HTMLInputElement).files?.[0];
    if (!file) throw new Error("Choose an Afterlight key backup.");
    applicationKey?.destroy();
    applicationKey = restoreKey(await file.text());
    if (role === "successor") successorPublicKey = applicationKey.publicKey;
    notice = `${role === "owner" ? "Owner" : "Successor"} key restored locally.`;
  }));
  document.querySelector<HTMLInputElement>("[name=successor-key]")?.addEventListener("input", (event) => {
    successorPublicKey = (event.currentTarget as HTMLInputElement).value.trim();
    const submit = document.querySelector<HTMLButtonElement>("#reserve-form button[type=submit]");
    if (submit) submit.disabled = !canFundReserve();
  });
  document.querySelector<HTMLInputElement>("[name=cost-ack]")?.addEventListener("change", (event) => {
    costAcknowledged = (event.currentTarget as HTMLInputElement).checked;
    render();
  });
  document.querySelectorAll<HTMLInputElement>("[name=reserve-mode]").forEach((input) => input.addEventListener("change", () => {
    reserveMode = input.value === "FAST_DEMO" ? "FAST_DEMO" : "NORMAL";
    render();
  }));
  document.querySelector<HTMLTextAreaElement>("[name=invitation]")?.addEventListener("input", (event) => {
    invitationText = (event.currentTarget as HTMLTextAreaElement).value;
    localStorage.setItem("afterlight:invitation:v1", invitationText);
    vault = undefined;
  });
  document.querySelector<HTMLButtonElement>("[data-action=validate-invitation]")?.addEventListener("click", () => render());
  document.querySelector<HTMLFormElement>("#reserve-form")?.addEventListener("submit", (event) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget as HTMLFormElement);
    void run(async () => {
      if (!hasPendingCheckpointReconciliation()) {
        await refreshSponsorCapacity();
        if (fundingCapacity !== "ready") throw new Error("New recovery reserves are paused until funding capacity is verified and available.");
      }
      if (!form.has("cost-ack") || !costAcknowledged) throw new Error("Confirm the exact 7 STRK private-wallet consequence first.");
      if (!ready || !applicationKey) throw new Error("Connect Ready X and generate the owner key first.");
      if (privateBalance === undefined || privateBalance < 7n * 10n ** 18n) throw new Error("At least 7 private STRK is required.");
      notice = "Requesting a fresh neutral funding checkpoint…"; render();
      const result = await fundRecoveryReserve({ ready, ownerKey: applicationKey, successorKey: successorPublicKey, mode: reserveMode,
        onCheckpoint: (hash) => { transactionHash = hash; notice = "Checkpoint succeeded. Confirm the single private FUND transaction in Ready X."; render(); },
        onSubmitted: (hash) => { transactionHash = hash; notice = "Private FUND submitted. Waiting for Mainnet success…"; render(); },
      });
      invitationText = JSON.stringify(result.invitation, null, 2);
      localStorage.setItem("afterlight:invitation:v1", invitationText);
      download(`afterlight-invitation-${result.invitation.vaultId.slice(2, 10)}.json`, invitationText);
      vault = await readVault(result.invitation.vaultId);
      privateBalance = await ready.balance(STRK);
      costAcknowledged = false;
      notice = "Recovery reserve is ACTIVE. Invitation downloaded; share it with the designated successor.";
    });
  });
  document.querySelectorAll<HTMLButtonElement>("[data-action=load-vault]").forEach((button) => button.addEventListener("click", () => void run(async () => {
    const parsed = parseInvitation(invitationText);
    if (!parsed.valid) throw new Error(parsed.reason);
    vault = await readVault(parsed.invitation.vaultId);
    if (!vault.exists) throw new Error("This vault does not exist on the deployed Afterlight contract.");
    assertInvitationMatchesVault(parsed.invitation, vault);
    notice = `Live vault loaded: ${stateName(vault.state)}.`;
  })));
  document.querySelectorAll<HTMLButtonElement>("[data-control]").forEach((button) => button.addEventListener("click", () => void run(async () => {
    const parsed = parseInvitation(invitationText);
    if (!parsed.valid || !vault || !applicationKey) throw new Error("Import the invitation, live vault and correct key first.");
    const operation = button.dataset.control as "HEARTBEAT" | "REQUEST" | "VETO";
    transactionHash = await relayControl(operation, parsed.invitation, vault, applicationKey);
    vault = await readVault(parsed.invitation.vaultId);
    notice = `${operation === "HEARTBEAT" ? "Heartbeat recorded" : operation === "REQUEST" ? "Recovery grace opened" : "Recovery vetoed"}. Mainnet state is now ${stateName(vault.state)}.`;
  })));
  const cancelDialog = document.querySelector<HTMLDialogElement>("#cancel-dialog");
  document.querySelector<HTMLButtonElement>("[data-action=cancel-refund]")?.addEventListener("click", () => cancelDialog?.showModal());
  document.querySelector<HTMLButtonElement>("[data-action=dismiss-cancel]")?.addEventListener("click", () => cancelDialog?.close());
  document.querySelector<HTMLButtonElement>("[data-action=confirm-cancel]")?.addEventListener("click", () => {
    cancelDialog?.close();
    void run(async () => {
    const parsed = parseInvitation(invitationText);
    if (!parsed.valid || !vault || !ready || !applicationKey) throw new Error("Connect Ready X and restore the designated owner key first.");
    const retained = pendingExit?.action === "CANCEL_REFUND" && pendingExit.vaultId === parsed.invitation.vaultId
      ? pendingExit
      : undefined;
    if (retained === undefined) {
      await refreshSponsorCapacity();
      if (exitCapacity !== "ready") throw new Error("Private cancellation is paused until sponsor exit capacity is restored.");
    }
    const balanceBefore = retained === undefined ? await ready.balance(STRK) : BigInt(retained.balanceBefore);
    let exitPackage = retained?.exitPackage;
    if (exitPackage === undefined) {
      notice = "Ready X will prepare one exact private return note. The neutral sponsor pays the pool and network fees."; render();
      exitPackage = await prepareExitPackage({ ready, invitation: parsed.invitation, vault, roleKey: applicationKey, action: "CANCEL_REFUND" });
      retainPendingExit({ action: "CANCEL_REFUND", vaultId: parsed.invitation.vaultId, exitPackage, balanceBefore: balanceBefore.toString() });
    }
    notice = retained ? "Reconciling the exact pending private return. No new note or authorization is being created." : "Owner authorization and exact return note verified. Submitting through the neutral sponsor…"; render();
    let result;
    try {
      result = await submitExitPackage(exitPackage);
    } catch (error) {
      if (error instanceof ExitSubmissionError && !error.ambiguous) retainPendingExit(undefined);
      throw error;
    }
    retainPendingExit(undefined);
    transactionHash = result.transactionHash;
    vault = await readVault(parsed.invitation.vaultId);
    privateBalance = await ready.balance(STRK);
    if (vault.state !== "4") throw new Error("The transaction succeeded but the vault is not CANCELLED. Do not retry.");
    if (privateBalance !== balanceBefore + 1n * 10n ** 18n) throw new Error("The vault is CANCELLED, but the expected 1 STRK shielded-balance increase is not visible yet. Refresh Ready X; do not retry.");
      notice = `Reserve returned privately. Your shielded balance increased from ${strk(balanceBefore)} to ${strk(privateBalance)}.`;
    });
  });
  document.querySelector<HTMLButtonElement>("[data-action=claim]")?.addEventListener("click", () => void run(async () => {
    const parsed = parseInvitation(invitationText);
    if (!parsed.valid || !vault || !ready || !applicationKey) throw new Error("Connect Ready X and restore the designated successor key first.");
    const retained = pendingExit?.action === "CLAIM" && pendingExit.vaultId === parsed.invitation.vaultId
      ? pendingExit
      : undefined;
    if (retained === undefined) {
      await refreshSponsorCapacity();
      if (exitCapacity !== "ready") throw new Error("Private recovery is paused until sponsor exit capacity is restored.");
    }
    const balanceBefore = retained === undefined ? await ready.balance(STRK) : BigInt(retained.balanceBefore);
    let claimPackage = retained?.exitPackage;
    if (claimPackage === undefined) {
      notice = "Ready X will prepare the exact private destination twice, then the neutral sponsor will submit it. The sponsor pays the pool and network fees."; render();
      claimPackage = await prepareExitPackage({ ready, invitation: parsed.invitation, vault, roleKey: applicationKey, action: "CLAIM" });
      retainPendingExit({ action: "CLAIM", vaultId: parsed.invitation.vaultId, exitPackage: claimPackage, balanceBefore: balanceBefore.toString() });
    }
    notice = retained ? "Reconciling the exact pending private claim. No new note or authorization is being created." : "Exact destination and designated-key authorization verified. Submitting through the neutral sponsor…"; render();
    let result;
    try {
      result = await submitExitPackage(claimPackage);
    } catch (error) {
      if (error instanceof ExitSubmissionError && !error.ambiguous) retainPendingExit(undefined);
      throw error;
    }
    retainPendingExit(undefined);
    transactionHash = result.transactionHash;
    vault = await readVault(parsed.invitation.vaultId);
    privateBalance = await ready.balance(STRK);
    if (vault.state !== "3") throw new Error("The transaction succeeded but the vault is not CLAIMED. Do not retry.");
    if (privateBalance !== balanceBefore + 1n * 10n ** 18n) throw new Error("The vault is CLAIMED, but the expected 1 STRK shielded-balance increase is not visible yet. Refresh Ready X; do not retry the claim.");
    notice = `Recovery complete. Your shielded balance increased from ${strk(balanceBefore)} to ${strk(privateBalance)}.`;
  }));
}

render();
void run(async () => {
  await assertMainnet();
  await readLiability();
  try {
    await refreshSponsorCapacity();
  } catch {
    exitCapacity = "unknown";
    fundingCapacity = "unknown";
  }
  const detection = detectReady();
  walletStatus = detection.found ? "available" : "missing";
  notice = detection.found ? `Ready X ${detection.version ?? ""} detected. No wallet request was made.` : "Ready X was not detected. You can still inspect and import a recovery invitation.";
});

window.addEventListener("beforeunload", () => applicationKey?.destroy());
