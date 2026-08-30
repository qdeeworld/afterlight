import "./style.css";
import { num } from "starknet";
import { RELAYER_URL, STRK } from "./config.ts";
import { assertMainnet, readLiability, readVault } from "./chain.ts";
import { parseInvitation, stateName, type RecoveryInvitation, type Role, type VaultSnapshot, type WalletStatus } from "./model.ts";
import { connectReady, detectReady, type ReadySession } from "./wallet.ts";
import { ExitSubmissionError, exportEncryptedKey, fundRecoveryReserve, generateKey, hasPendingCheckpointReconciliation, isLegacyPlaintextKeyBackup, prepareExitPackage, relayControl, restoreEncryptedKey, restoreKey, submitControlDirect, submitExitPackage } from "./operations.ts";
import { isThemePreference, resolveTheme, type ThemePreference } from "./theme.ts";
import type { LocalStarkKey } from "../../client/src/keys.ts";

const THEME_STORAGE_KEY = "afterlight:theme:v1";
const colorScheme = window.matchMedia("(prefers-color-scheme: dark)");
const storedTheme = localStorage.getItem(THEME_STORAGE_KEY);
let themePreference: ThemePreference = isThemePreference(storedTheme) ? storedTheme : "system";

function applyTheme(): void {
  const theme = resolveTheme(themePreference, colorScheme.matches);
  document.documentElement.dataset.theme = theme;
  document.documentElement.style.colorScheme = theme;
  document.querySelector<HTMLMetaElement>('meta[name="theme-color"]')?.setAttribute("content", theme === "dark" ? "#0d100f" : "#f3efe6");
}

applyTheme();

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
let costAcknowledged = false;
let backupState: "needed" | "downloaded" | "verified" = "needed";

type ReceiptEvidence = Readonly<{
  hash: string;
  label: string;
  vaultId?: string;
  recordedAt: string;
}>;

const RECEIPT_STORAGE_KEY = "afterlight:receipts:v1";

function restoreReceipts(): ReceiptEvidence[] {
  try {
    const value = JSON.parse(localStorage.getItem(RECEIPT_STORAGE_KEY) ?? "[]") as unknown;
    if (!Array.isArray(value)) return [];
    return value.filter((entry): entry is ReceiptEvidence => {
      if (typeof entry !== "object" || entry === null) return false;
      const item = entry as Partial<ReceiptEvidence>;
      return /^0x[0-9a-f]{1,64}$/i.test(item.hash ?? "")
        && typeof item.label === "string"
        && item.label.length > 0
        && item.label.length <= 80
        && (item.vaultId === undefined || /^0x[0-9a-f]{1,64}$/i.test(item.vaultId))
        && typeof item.recordedAt === "string";
    }).slice(0, 8);
  } catch {
    return [];
  }
}

let receipts = restoreReceipts();

function recordReceipt(hash: string, label: string, vaultId?: string): void {
  const evidence = Object.freeze({ hash: num.toHex(BigInt(hash)), label, vaultId, recordedAt: new Date().toISOString() });
  receipts = [evidence, ...receipts.filter((item) => item.hash !== evidence.hash)].slice(0, 8);
  localStorage.setItem(RECEIPT_STORAGE_KEY, JSON.stringify(receipts));
}
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

function progressStep(index: number, label: string, detail: string, complete: boolean, current: boolean): string {
  const state = complete ? "complete" : current ? "current" : "upcoming";
  return `<li data-state="${state}"><span aria-hidden="true">${complete ? "✓" : index}</span><div><strong>${label}</strong><small>${detail}</small></div></li>`;
}

function journeyProgress(): string {
  const invitationValid = parseInvitation(invitationText).valid;
  const hasWallet = walletStatus === "connected";
  const hasKey = Boolean(applicationKey);
  if (role === "owner") {
    return `<ol class="journey-progress" aria-label="Owner journey progress">
      ${progressStep(1, "Connect", "Ready X", hasWallet, !hasWallet)}
      ${progressStep(2, "Set up", "Keys and terms", invitationValid, hasWallet && !invitationValid)}
      ${progressStep(3, "Protect", "Fund and stay active", vault?.exists === true, invitationValid)}
    </ol>`;
  }
  return `<ol class="journey-progress" aria-label="Successor journey progress">
    ${progressStep(1, "Prepare", "Your recovery key", hasKey, !hasKey)}
    ${progressStep(2, "Verify", "Recovery invitation", invitationValid, hasKey && !invitationValid)}
    ${progressStep(3, "Recover", "Live vault and claim", vault?.exists === true, invitationValid)}
  </ol>`;
}

function journeySignal(): string {
  const invitationValid = parseInvitation(invitationText).valid;
  const current = vault?.exists ? stateName(vault.state) : undefined;
  let now: string;
  let safe: string;
  let next: string;

  if (role === "owner") {
    if (walletStatus !== "connected") now = "Connect Ready X";
    else if (!applicationKey || backupState !== "verified") now = "Secure your owner key";
    else if (!invitationValid) now = "Set the successor and terms";
    else if (!vault?.exists) now = "Fund the reserve privately";
    else if (current === "GRACE") now = "Veto or allow recovery";
    else if (current === "ACTIVE") now = "Keep the heartbeat current";
    else now = "Review the completed outcome";
    safe = current === "ACTIVE" ? "Reserve remains protected" : current === "GRACE" ? "Owner control remains live" : invitationValid ? "Invitation verified locally" : "No funds move before confirmation";
    next = current === "ACTIVE" ? "Heartbeat, cancel, or wait" : current === "GRACE" ? "First valid veto or claim wins" : vault?.exists ? "Terminal state cannot replay" : "Exact cost appears before funding";
  } else {
    if (!applicationKey || backupState !== "verified") now = "Secure your successor key";
    else if (!invitationValid) now = "Import the recovery invitation";
    else if (!vault?.exists) now = "Read the live reserve";
    else if (current === "ACTIVE") now = "Wait until inactivity expires";
    else if (current === "GRACE") now = "Wait for grace, then recover";
    else now = "Review the completed outcome";
    safe = current === "CLAIMED" ? "Recovery settled exactly once" : invitationValid ? "Invitation matches the designated key" : "Your secret stays on this device";
    next = current === "GRACE" ? "Claim binds one exact private note" : current === "ACTIVE" ? "Request opens the owner veto window" : vault?.exists ? "Terminal state cannot replay" : "No wallet request before verification";
  }

  return `<section class="journey-signal" aria-label="Current recovery summary"><div data-signal="now"><span>Now</span><strong>${escapeHtml(now)}</strong></div><div data-signal="safe"><span>Safe</span><strong>${escapeHtml(safe)}</strong></div><div data-signal="next"><span>Next</span><strong>${escapeHtml(next)}</strong></div></section>`;
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
  return `<section class="key-panel" data-complete="${applicationKey && isCurrent && backupState === "verified"}"><div class="section-heading"><span class="step-number">${person === "owner" ? "02" : "01"}</span>
    <div><strong>${person === "owner" ? "Create your owner control key" : "Prepare your successor key"}</strong><p>Generated locally for one vault. The secret never reaches the relayer or Ready X.</p></div></div>
    ${applicationKey && isCurrent ? `<code>${escapeHtml(applicationKey.publicKey)}</code><div class="password-fields" role="group" aria-labelledby="backup-password-title"><strong id="backup-password-title">Protect the backup with a password</strong><label class="full-field"><span>Backup password</span><input data-backup-password type="password" minlength="12" maxlength="256" autocomplete="new-password" spellcheck="false" /><small>Use at least 12 characters. Afterlight never stores or receives this password.</small></label><label class="full-field"><span>Confirm backup password</span><input data-backup-password-confirm type="password" minlength="12" maxlength="256" autocomplete="new-password" spellcheck="false" /></label></div><div class="button-row"><button class="button secondary" data-action="copy-key">Copy public key</button><button class="button secondary" data-action="download-key">Download encrypted backup</button></div><p class="${backupState === "verified" ? "success" : "warning"}">${backupState === "verified" ? "Encrypted backup restored and verified on this device." : backupState === "downloaded" ? "Now restore the downloaded file below to verify its password before funding." : "Download and restore the encrypted key backup before funding."}</p>` : `<button class="button secondary" data-action="generate-key">Generate ${person} key locally</button>`}
    <aside class="secret-warning"><strong>Password protected signing key</strong><p>The exported JSON uses PBKDF2 and AES GCM encryption in this browser. Keep the file and password separate. Losing the password makes the backup unrecoverable.</p></aside>
    <details class="restore-key" ${backupState === "downloaded" ? "open" : ""}><summary>Restore and verify a key backup</summary><div class="password-fields"><label class="full-field"><span>Backup password</span><input data-restore-password type="password" minlength="12" maxlength="256" autocomplete="current-password" spellcheck="false" /></label><label class="full-field"><span>Restore ${person} key backup</span><input data-key-file type="file" accept="application/json,.json" /><small>Decrypted locally only. Existing version 1 plaintext backups remain importable for migration and should be replaced immediately.</small></label></div></details>
  </section>`;
}

function walletRow(): string {
  return `<section class="wallet-row" data-status="${walletStatus}"><div class="section-heading"><span class="step-number">01</span><div><strong>Connect Ready X</strong><span>${escapeHtml(walletCopy())}</span></div></div><button class="button secondary" data-action="connect" ${busy ? "disabled" : ""}>${walletStatus === "connected" ? "Refresh balance" : "Connect"}</button></section>`;
}

function canFundReserve(): boolean {
  return (fundingCapacity === "ready" || hasPendingCheckpointReconciliation())
    && walletStatus === "connected"
    && privateBalance !== undefined
    && privateBalance >= 7n * 10n ** 18n
    && applicationKey !== undefined
    && backupState === "verified"
    && /^0x[0-9a-f]{1,64}$/i.test(successorPublicKey)
    && costAcknowledged;
}

function ownerView(): string {
  const invitation = parseInvitation(invitationText);
  const canFund = canFundReserve();
  const pendingFunding = hasPendingCheckpointReconciliation();
  const liveControls = invitation.valid && vault?.exists;
  return `<section class="journey recovery-chamber" data-role-view="owner" aria-labelledby="owner-heading">
    <header class="journey-heading"><div><p class="eyebrow">Owner path · Starknet Mainnet</p><h2 id="owner-heading">Create a recovery reserve</h2><p class="lede">Privately set aside 1 STRK. Stay in control while active and veto during the recovery window.</p></div><span class="journey-mode">${reserveMode === "NORMAL" ? "Long-term reserve" : "Recovery Drill"}<strong>1 STRK</strong></span></header>
    ${journeyProgress()}
    <div class="journey-body">${walletRow()}
    ${keyPanel("owner")}
    <form id="reserve-form" class="setup-form" data-ready="${canFund}"><div class="section-heading"><span class="step-number">03</span><div><strong>Choose the recovery terms</strong><p>Normal mode is the long-term default. The drill uses the same rules on a shorter clock.</p></div></div>
      <fieldset><legend>Choose a timing mode</legend><label class="choice ${reserveMode === "NORMAL" ? "selected" : ""}"><input type="radio" name="reserve-mode" value="NORMAL" ${reserveMode === "NORMAL" ? "checked" : ""} /><span><strong>30 days + 7 days</strong><small>Long-term inactivity and grace</small></span></label><label class="choice ${reserveMode === "FAST_DEMO" ? "selected" : ""}"><input type="radio" name="reserve-mode" value="FAST_DEMO" ${reserveMode === "FAST_DEMO" ? "checked" : ""} /><span><strong>5 min + 5 min</strong><small>Clearly labelled Recovery Drill</small></span></label></fieldset>
      <label class="full-field"><span>Designated successor public key</span><input name="successor-key" autocomplete="off" spellcheck="false" placeholder="0x…" value="${escapeHtml(successorPublicKey)}" /><small>The successor must generate this independently. Do not accept their secret.</small></label>
      <aside class="cost-note"><strong>Exact private-wallet consequence</strong><p>Creating this reserve uses 1 STRK as recoverable principal plus Ready’s separate 6 STRK private-action fee. You will confirm one Ready X transaction. Neutral exit sponsorship is capacity-limited and rechecked later; recovery or cancellation waits if capacity must be restored.</p></aside>
      <label class="ack"><input name="cost-ack" type="checkbox" ${costAcknowledged ? "checked" : ""} /><span>I understand this action uses 7 STRK from my shielded balance.</span></label>
      <button class="button primary" type="submit" ${canFund ? "" : "disabled"}>${pendingFunding ? "Reconcile pending funding checkpoint" : fundingCapacity === "exhausted" ? "New reserves temporarily paused" : fundingCapacity === "checking" ? "Checking recovery capacity" : fundingCapacity === "unknown" ? "Recovery capacity unavailable" : !costAcknowledged ? "Confirm the 7 STRK cost to continue" : "Create and privately fund reserve"}</button>
      ${pendingFunding ? `<p class="warning">This tab has an unresolved funding checkpoint. Continue only to reconcile that exact attempt; the Worker still performs the authoritative owner-aware capacity check.</p>` : fundingCapacity === "exhausted" ? `<p class="error">Every fully backed vault slot is currently occupied or private-exit capacity needs replenishment. Existing vault controls remain available.</p>` : fundingCapacity === "unknown" ? `<p class="error">Recovery capacity could not be verified. Funding stays disabled to protect users.</p>` : ""}
      ${privateBalance !== undefined && privateBalance < 7n * 10n ** 18n ? `<p class="error">At least 7 private STRK is required for this action.</p>` : ""}
      ${applicationKey && backupState !== "verified" ? `<p class="error">Download and restore the owner key backup before funding.</p>` : ""}
    </form>
    ${invitation.valid ? controlPanel(invitation.invitation, liveControls ? vault : undefined) : ""}</div>
    <details class="restore-reserve utility-panel"><summary>Restore an existing owner reserve</summary><div class="restore-reserve-body"><label class="full-field"><span>Recovery invitation</span><textarea name="owner-invitation" rows="7" placeholder="Paste Afterlight invitation JSON">${escapeHtml(invitationText)}</textarea><small>Use this after browser storage loss. The package is checked locally against Mainnet before controls are enabled.</small></label><button class="button secondary" data-action="validate-owner-invitation">Verify and load reserve</button></div></details>
  </section>`;
}

function successorView(): string {
  const parsed = parseInvitation(invitationText);
  return `<section class="journey recovery-chamber" data-role-view="successor" aria-labelledby="successor-heading">
    <header class="journey-heading"><div><p class="eyebrow">Successor path · Starknet Mainnet</p><h2 id="successor-heading">Prepare to recover a reserve</h2><p class="lede">Generate your own per-vault key, verify the invitation, and request only after authenticated inactivity.</p></div><span class="journey-mode">Designated key<strong>Exact note only</strong></span></header>
    ${journeyProgress()}
    <div class="journey-body">${keyPanel("successor")}
    ${invitationPanel(parsed)}
    ${parsed.valid ? `${walletRow()}${controlPanel(parsed.invitation, vault)}` : ""}</div>
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

function formatDeadline(unixSeconds: number): string {
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(unixSeconds * 1000));
}

function controlPanel(invitation: RecoveryInvitation, snapshot?: VaultSnapshot): string {
  if (!snapshot) return `<section class="control-panel next-action"><div class="section-heading"><span class="step-number">04</span><div><strong>Read the live reserve</strong><p>Confirm the current Mainnet state before taking action.</p></div></div><button class="button primary" data-action="load-vault" ${busy ? "disabled" : ""}>Read live vault state</button></section>`;
  const current = stateName(snapshot.state);
  const pendingCancellation = role === "owner" && pendingExit?.action === "CANCEL_REFUND" && pendingExit.vaultId === invitation.vaultId;
  const pendingClaim = role === "successor" && pendingExit?.action === "CLAIM" && pendingExit.vaultId === invitation.vaultId;
  const now = Math.floor(Date.now() / 1000);
  const inactiveAt = Number(snapshot.lastHeartbeat) + Number(snapshot.inactivitySeconds);
  const requestReady = current === "ACTIVE" && now >= inactiveAt;
  const claimReady = current === "GRACE" && now >= Number(snapshot.claimAfter);
  const emergencyOperation = role === "owner" && current === "ACTIVE"
    ? "HEARTBEAT"
    : role === "owner" && current === "GRACE"
      ? "VETO"
      : role === "successor" && current === "ACTIVE" && requestReady
        ? "REQUEST"
        : undefined;
  const timingLabel = current === "GRACE" ? "Claim after" : current === "ACTIVE" ? "Inactive after" : "Settlement";
  const timingValue = current === "GRACE"
    ? formatDeadline(Number(snapshot.claimAfter))
    : current === "ACTIVE"
      ? formatDeadline(inactiveAt)
      : current;
  const stateCopy = current === "ACTIVE" ? "Protected and listening for an authenticated heartbeat." : current === "GRACE" ? "Recovery requested. The owner can still veto before settlement." : current === "CLAIMED" ? "Recovery completed exactly once to the designated private note." : "The reserve returned privately to its owner.";
  return `<section class="control-panel live-state" data-vault-state="${current}"><div class="state-beacon" aria-hidden="true"><span></span></div><div class="control-heading"><div><span class="state-chip">${current}</span><h3>${current === "ACTIVE" ? "Reserve protected" : current === "GRACE" ? "Owner still has control" : current === "CLAIMED" ? "Recovery complete" : "Reserve returned"}</h3><p>${stateCopy}</p><small>Vault ${short(invitation.vaultId)} · epoch ${snapshot.epoch}</small></div><button class="text-button" data-action="load-vault">Refresh state</button></div>
    <div class="metrics"><div><span>Reserve</span><strong>1 STRK</strong></div><div><span>${timingLabel}</span><strong>${timingValue}</strong></div></div>
    ${pendingCancellation ? `<button class="button danger" data-action="cancel-refund" ${!applicationKey || !ready || busy ? "disabled" : ""}>Reconcile pending private return</button><p class="warning">This reuses the exact retained note and authorization; it does not prepare another exit.</p>` : ""}
    ${pendingClaim ? `<button class="button primary" data-action="claim" ${!applicationKey || !ready || busy ? "disabled" : ""}>Reconcile pending private recovery</button><p class="warning">This reuses the exact retained note and authorization; it does not prepare another exit.</p>` : ""}
    ${role === "owner" && current === "ACTIVE" && !pendingCancellation ? `<button class="button primary" data-control="HEARTBEAT" ${!applicationKey || busy ? "disabled" : ""}>Send private heartbeat</button><button class="button danger" data-action="cancel-refund" ${!applicationKey || !ready || exitCapacity !== "ready" || busy ? "disabled" : ""}>Cancel and return 1 STRK privately</button>${exitCapacity !== "ready" ? `<p class="error">Private cancellation is paused until sponsor exit capacity is restored.</p>` : ""}` : ""}
    ${role === "owner" && current === "GRACE" ? `<button class="button primary" data-control="VETO" ${!applicationKey || busy ? "disabled" : ""}>Veto recovery</button>` : ""}
    ${role === "successor" && current === "ACTIVE" ? `<button class="button primary" data-control="REQUEST" ${!applicationKey || !requestReady || busy ? "disabled" : ""}>${requestReady ? "Request recovery" : "Request opens after inactivity"}</button>` : ""}
    ${role === "successor" && current === "GRACE" && !pendingClaim ? `<button class="button primary" ${claimReady && ready && applicationKey && exitCapacity === "ready" ? "" : "disabled"} data-action="claim">${exitCapacity === "exhausted" ? "Private recovery temporarily paused" : claimReady ? "Recover 1 STRK privately" : "Grace period is active"}</button>${exitCapacity !== "ready" && claimReady ? `<p class="error">Private recovery is paused until sponsor exit capacity is restored.</p>` : ""}` : ""}
    <p class="action-help">Heartbeat, request and veto use your local signature through the neutral relayer. The Ready wallet address is not sent.</p>
    ${emergencyOperation ? `<details class="emergency-fallback"><summary>Emergency wallet submission</summary><p>This restores control if the neutral relayer is unavailable, but it publicly links this Ready wallet address to the vault. Use it only when availability matters more than unlinkability.</p><button class="button danger" data-direct-control="${emergencyOperation}" ${!applicationKey || !ready || busy ? "disabled" : ""}>Submit ${emergencyOperation.toLowerCase()} from Ready X publicly</button></details>` : ""}
  </section>`;
}

function statusPanel(): string {
  const parsed = parseInvitation(invitationText);
  const current = vault?.exists ? stateName(vault.state) : "Not loaded";
  const headline = current === "CLAIMED" ? "Recovery complete" : current === "CANCELLED" ? "Reserve returned" : current === "GRACE" ? "Owner still has control" : current === "ACTIVE" ? "Reserve protected" : "Private by design";
  const contextualReceipts = receipts
    .filter((item) => !parsed.valid || item.vaultId === undefined || item.vaultId === parsed.invitation.vaultId)
    .slice(0, 3);
  return `<aside class="status-panel recovery-map"><div class="map-orbit" aria-hidden="true"><span></span><i></i></div><p class="status-label">${current === "Not loaded" ? "Recovery map" : "Live outcome"}</p><strong>${headline}</strong><p>${parsed.valid ? `${current} · ${short(parsed.invitation.vaultId)}` : "Create or import a reserve to activate its live recovery map."}</p>
    <div class="trace"><div><span>✓</span><p><strong>Funding relationship</strong><small>Unlinked by STRK20</small></p></div><div><span>✓</span><p><strong>Heartbeat and veto wallet</strong><small>Unlinked when the neutral relay is used</small></p></div><div><span>✓</span><p><strong>Recovery destination</strong><small>Bound to one exact private note</small></p></div><div class="public"><span>○</span><p><strong>Timing and denomination</strong><small>Remain public</small></p></div></div>
    ${contextualReceipts.length ? `<div class="receipt-history" aria-label="Recent Mainnet actions"><strong>Recent Mainnet actions</strong>${contextualReceipts.map((item) => `<a class="receipt" href="https://voyager.online/tx/${escapeHtml(item.hash)}" target="_blank" rel="noreferrer"><span>${escapeHtml(item.label)}</span><small>${new Date(item.recordedAt).toLocaleString()}</small></a>`).join("")}</div>` : ""}
    <details><summary>Truthful privacy boundary</summary><p>The contract, token, fixed denomination, application public keys, timing and state changes remain public. Ready wallet relationships and later private-note activity stay unlinked.</p></details></aside>`;
}

function render(): void {
  const reconcilingCancellation = pendingExit?.action === "CANCEL_REFUND";
  app.innerHTML = `<div class="ambient-glow" aria-hidden="true"></div><header class="site-header"><a class="brand" href="/"><span aria-hidden="true"><i></i></span>Afterlight</a><div class="header-tools"><label class="theme-control"><span>Appearance</span><select data-theme-preference aria-label="Appearance"><option value="system" ${themePreference === "system" ? "selected" : ""}>System</option><option value="light" ${themePreference === "light" ? "selected" : ""}>Light</option><option value="dark" ${themePreference === "dark" ? "selected" : ""}>Dark</option></select></label><div class="network"><span aria-hidden="true"></span><strong>Mainnet</strong><small>Starknet</small></div></div></header>
  <main id="main"><section class="intro"><div class="intro-copy"><p class="kicker">Private recovery, under your control</p><h1>A reserve that waits for the person you trust.</h1><p>Fund privately. Stay present through heartbeat and veto. If you go inactive, only the designated successor key can authorize recovery to one exact private note.</p></div><div class="afterlight-orbit" aria-hidden="true"><span class="orbit orbit-one"></span><span class="orbit orbit-two"></span><span class="orbit-core"></span><small>protected<br />until needed</small></div></section>
  <nav class="role-switch" aria-label="Choose your recovery role"><button class="role-choice" data-role="owner" aria-pressed="${role === "owner"}"><span class="role-index">01</span><span><strong>I own the reserve</strong><small>Create, heartbeat, veto or cancel</small></span><b aria-hidden="true">↗</b></button><button class="role-choice" data-role="successor" aria-pressed="${role === "successor"}"><span class="role-index">02</span><span><strong>I am the successor</strong><small>Prepare, request and recover</small></span><b aria-hidden="true">↗</b></button></nav>
  ${journeySignal()}
  <div class="activity-banner" role="status" aria-live="polite" data-busy="${busy}"><span aria-hidden="true">${busy ? "…" : ""}</span><p>${busy ? "Working · " : ""}${escapeHtml(notice)}</p></div>
  <div class="content-grid">${role === "owner" ? ownerView() : successorView()}${statusPanel()}</div></main>
  <footer><span>Recovery infrastructure, not legal inheritance automation.</span><div><span>Built with STRK20 on Starknet</span><a href="https://github.com/dolepee/afterlight">Open source contract ↗</a></div></footer>
  <dialog id="cancel-dialog" aria-labelledby="cancel-title" aria-describedby="cancel-description"><form method="dialog"><p class="eyebrow">Private return</p><h2 id="cancel-title">${reconcilingCancellation ? "Reconcile the pending return?" : "Cancel this reserve?"}</h2><p id="cancel-description">${reconcilingCancellation ? "Afterlight will resubmit the exact retained package only to reconcile its receipt. No new note or authorization is prepared." : "Its 1 STRK principal returns to this Ready X private balance. The reserve cannot be recovered afterward."}</p><div class="button-row"><button class="button secondary" type="button" data-action="dismiss-cancel">${reconcilingCancellation ? "Not now" : "Keep reserve active"}</button><button class="button danger" type="button" data-action="confirm-cancel">${reconcilingCancellation ? "Reconcile exact package" : "Cancel and return 1 STRK"}</button></div></form></dialog>`;
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
  document.querySelector<HTMLSelectElement>("[data-theme-preference]")?.addEventListener("change", (event) => {
    const value = (event.currentTarget as HTMLSelectElement).value;
    if (!isThemePreference(value)) return;
    themePreference = value;
    localStorage.setItem(THEME_STORAGE_KEY, value);
    applyTheme();
  });
  document.querySelectorAll<HTMLButtonElement>("[data-role]").forEach((button) => button.addEventListener("click", () => {
    const nextRole = button.dataset.role === "successor" ? "successor" : "owner";
    if (nextRole === role) return;
    if (applicationKey && backupState !== "verified") {
      notice = "Verify this key backup before switching roles. Afterlight will not discard an unverified recovery key.";
      render();
      return;
    }
    role = nextRole;
    applicationKey?.destroy();
    applicationKey = undefined;
    backupState = "needed";
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
    backupState = "needed";
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
    const key = applicationKey;
    const passwordInput = document.querySelector<HTMLInputElement>("[data-backup-password]");
    const confirmationInput = document.querySelector<HTMLInputElement>("[data-backup-password-confirm]");
    const password = passwordInput?.value ?? "";
    const confirmation = confirmationInput?.value ?? "";
    void run(async () => {
      if (!key) throw new Error("Generate or restore a key first.");
      if (password !== confirmation) throw new Error("The backup passwords do not match.");
      const encrypted = await exportEncryptedKey(key, password);
      download(`afterlight-${role}-key-${key.publicKey.slice(2, 10)}.json`, encrypted);
      backupState = "downloaded";
      notice = "Encrypted secret backup downloaded. Restore this exact file and password below before funding, then keep them separate.";
    });
  });
  document.querySelector<HTMLInputElement>("[data-key-file]")?.addEventListener("change", (event) => {
    const file = (event.currentTarget as HTMLInputElement).files?.[0];
    const password = document.querySelector<HTMLInputElement>("[data-restore-password]")?.value ?? "";
    void run(async () => {
      if (!file) throw new Error("Choose an Afterlight key backup.");
      const serialized = await file.text();
      const legacy = isLegacyPlaintextKeyBackup(serialized);
      const restored = legacy ? restoreKey(serialized) : await restoreEncryptedKey(serialized, password);
      applicationKey?.destroy();
      applicationKey = restored;
      backupState = "verified";
      if (role === "successor") successorPublicKey = applicationKey.publicKey;
      notice = legacy
        ? `${role === "owner" ? "Owner" : "Successor"} legacy plaintext backup restored. Download a new encrypted backup before continuing.`
        : `${role === "owner" ? "Owner" : "Successor"} encrypted key backup restored and verified locally.`;
      if (legacy) backupState = "needed";
    });
  });
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
  document.querySelector<HTMLTextAreaElement>("[name=owner-invitation]")?.addEventListener("input", (event) => {
    invitationText = (event.currentTarget as HTMLTextAreaElement).value;
    localStorage.setItem("afterlight:invitation:v1", invitationText);
    vault = undefined;
  });
  document.querySelector<HTMLButtonElement>("[data-action=validate-owner-invitation]")?.addEventListener("click", () => void run(async () => {
    const parsed = parseInvitation(invitationText);
    if (!parsed.valid) throw new Error(parsed.reason);
    vault = await readVault(parsed.invitation.vaultId);
    if (!vault.exists) throw new Error("This vault does not exist on the deployed Afterlight contract.");
    assertInvitationMatchesVault(parsed.invitation, vault);
    notice = `Owner reserve restored from its invitation. Mainnet state: ${stateName(vault.state)}.`;
  }));
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
        onCheckpoint: () => { notice = "Checkpoint succeeded. Confirm the single private FUND transaction in Ready X."; render(); },
        onSubmitted: () => { notice = "Private FUND submitted. Waiting for Mainnet success…"; render(); },
      });
      recordReceipt(result.transactionHash, "Private reserve funded", result.invitation.vaultId);
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
    const controlHash = await relayControl(operation, parsed.invitation, vault, applicationKey);
    recordReceipt(controlHash, operation === "HEARTBEAT" ? "Heartbeat recorded" : operation === "REQUEST" ? "Recovery requested" : "Recovery vetoed", parsed.invitation.vaultId);
    vault = await readVault(parsed.invitation.vaultId);
    notice = `${operation === "HEARTBEAT" ? "Heartbeat recorded" : operation === "REQUEST" ? "Recovery grace opened" : "Recovery vetoed"}. Mainnet state is now ${stateName(vault.state)}.`;
  })));
  document.querySelectorAll<HTMLButtonElement>("[data-direct-control]").forEach((button) => button.addEventListener("click", () => {
    const operation = button.dataset.directControl as "HEARTBEAT" | "REQUEST" | "VETO";
    if (!window.confirm("Emergency fallback makes the connected Ready wallet address public and linkable to this vault. Continue?")) return;
    void run(async () => {
      const parsed = parseInvitation(invitationText);
      if (!parsed.valid || !vault || !applicationKey || !ready) throw new Error("Connect Ready X and restore the correct application key first.");
      const controlHash = await submitControlDirect(operation, parsed.invitation, vault, applicationKey, ready);
      recordReceipt(controlHash, `${operation === "HEARTBEAT" ? "Heartbeat" : operation === "REQUEST" ? "Recovery request" : "Recovery veto"} submitted publicly by emergency fallback`, parsed.invitation.vaultId);
      vault = await readVault(parsed.invitation.vaultId);
      notice = `Emergency ${operation.toLowerCase()} succeeded. This Ready wallet address is now publicly linkable to the vault.`;
    });
  }));
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
      notice = "Ready X will prepare one exact private return note. The sponsor signs the bounded transaction, then this browser broadcasts it independently."; render();
      exitPackage = await prepareExitPackage({ ready, invitation: parsed.invitation, vault, roleKey: applicationKey, action: "CANCEL_REFUND" });
      retainPendingExit({ action: "CANCEL_REFUND", vaultId: parsed.invitation.vaultId, exitPackage, balanceBefore: balanceBefore.toString() });
    }
    notice = retained ? "Reconciling the exact pending private return. No new note or authorization is being created." : "Owner authorization and exact return note verified. Requesting the bounded sponsor signature…"; render();
    let result;
    try {
      result = await submitExitPackage(exitPackage);
    } catch (error) {
      if (error instanceof ExitSubmissionError && !error.ambiguous) retainPendingExit(undefined);
      throw error;
    }
    retainPendingExit(undefined);
    recordReceipt(result.transactionHash, "Reserve returned privately", parsed.invitation.vaultId);
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
      notice = "Ready X will prepare the exact private destination twice. The sponsor signs the bounded transaction, then this browser broadcasts it independently."; render();
      claimPackage = await prepareExitPackage({ ready, invitation: parsed.invitation, vault, roleKey: applicationKey, action: "CLAIM" });
      retainPendingExit({ action: "CLAIM", vaultId: parsed.invitation.vaultId, exitPackage: claimPackage, balanceBefore: balanceBefore.toString() });
    }
    notice = retained ? "Reconciling the exact pending private claim. No new note or authorization is being created." : "Exact destination and designated-key authorization verified. Requesting the bounded sponsor signature…"; render();
    let result;
    try {
      result = await submitExitPackage(claimPackage);
    } catch (error) {
      if (error instanceof ExitSubmissionError && !error.ambiguous) retainPendingExit(undefined);
      throw error;
    }
    retainPendingExit(undefined);
    recordReceipt(result.transactionHash, "Recovery completed privately", parsed.invitation.vaultId);
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
colorScheme.addEventListener("change", () => {
  if (themePreference === "system") applyTheme();
});
