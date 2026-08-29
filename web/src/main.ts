import "./style.css";
import { num } from "starknet";
import { STRK } from "./config.ts";
import { assertMainnet, readLiability, readVault } from "./chain.ts";
import { parseInvitation, stateName, type RecoveryInvitation, type Role, type VaultSnapshot, type WalletStatus } from "./model.ts";
import { connectReady, detectReady, type ReadySession } from "./wallet.ts";
import { exportKey, fundRecoveryDrill, generateKey, prepareClaimPackage, relayControl, restoreKey, submitClaimPackage } from "./operations.ts";
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
let claimRetryBlocked = false;

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
  return `<section class="key-panel">
    <div><strong>${person === "owner" ? "Owner control key" : "Successor recovery key"}</strong><p>Generated locally for one vault. The secret never reaches the relayer or Ready X.</p></div>
    ${applicationKey && isCurrent ? `<code>${escapeHtml(applicationKey.publicKey)}</code><div class="button-row"><button class="button secondary" data-action="copy-key">Copy public key</button><button class="button secondary" data-action="download-key">Download secret backup</button></div>` : `<button class="button secondary" data-action="generate-key">Generate ${person} key locally</button>`}
    <label class="full-field"><span>Restore an existing ${person} key backup</span><input data-key-file type="file" accept="application/json,.json" /><small>Read only on this device. Never share this file.</small></label>
  </section>`;
}

function walletRow(): string {
  return `<div class="wallet-row" data-status="${walletStatus}"><div><strong>Ready X</strong><span>${escapeHtml(walletCopy())}</span></div><button class="button secondary" data-action="connect" ${busy ? "disabled" : ""}>${walletStatus === "connected" ? "Refresh balance" : "Connect Ready X"}</button></div>`;
}

function ownerView(): string {
  const invitation = parseInvitation(invitationText);
  const canFund = walletStatus === "connected" && privateBalance !== undefined && privateBalance >= 7n * 10n ** 18n && applicationKey && /^0x[0-9a-f]{1,64}$/i.test(successorPublicKey);
  const liveControls = invitation.valid && vault?.exists;
  return `<section class="journey" aria-labelledby="owner-heading">
    <p class="eyebrow">Owner · live Mainnet journey</p>
    <h2 id="owner-heading">Create a recovery reserve</h2>
    <p class="lede">Privately set aside 1 STRK. Heartbeat while active and veto a recovery request during grace.</p>
    ${walletRow()}
    ${keyPanel("owner")}
    <form id="reserve-form">
      <fieldset><legend>Recovery Drill terms</legend><div class="choice selected"><span><strong>1 STRK reserve</strong><small>Fixed by the deployed contract</small></span></div><div class="choice selected"><span><strong>5 min + 5 min</strong><small>Inactivity, then grace</small></span></div></fieldset>
      <label class="full-field"><span>Designated successor public key</span><input name="successor-key" autocomplete="off" spellcheck="false" placeholder="0x…" value="${escapeHtml(successorPublicKey)}" /><small>The successor must generate this independently. Do not accept their secret.</small></label>
      <aside class="cost-note"><strong>Exact private-wallet consequence</strong><p>Creating this drill uses 1 STRK as recoverable principal plus Ready’s separate 6 STRK private-action fee. You will confirm one Ready X transaction.</p></aside>
      <label class="ack"><input name="cost-ack" type="checkbox" ${costAcknowledged ? "checked" : ""} /><span>I understand this action uses 7 STRK from my shielded balance.</span></label>
      <button class="button primary" type="submit" ${canFund ? "" : "disabled"}>Create and privately fund reserve</button>
      ${privateBalance !== undefined && privateBalance < 7n * 10n ** 18n ? `<p class="error">At least 7 private STRK is required for this action.</p>` : ""}
    </form>
    ${invitation.valid ? controlPanel(invitation.invitation, liveControls ? vault : undefined) : ""}
  </section>`;
}

function successorView(): string {
  const parsed = parseInvitation(invitationText);
  return `<section class="journey" aria-labelledby="successor-heading">
    <p class="eyebrow">Successor · live Mainnet journey</p>
    <h2 id="successor-heading">Recover a reserve privately</h2>
    <p class="lede">Generate your own per-vault key, import the invitation, and request only after authenticated inactivity.</p>
    ${keyPanel("successor")}
    <label class="full-field"><span>Recovery invitation</span><textarea name="invitation" rows="9" placeholder="Paste Afterlight invitation JSON">${escapeHtml(invitationText)}</textarea><small>Validated locally before any wallet or relay action.</small></label>
    <div class="invitation-result" data-valid="${parsed.valid}"><strong>${parsed.valid ? "Invitation verified locally" : "Invitation not verified"}</strong><p>${escapeHtml(parsed.valid ? "Contract, vault, designated key, token, amount and mode match Afterlight Mainnet." : parsed.reason)}</p></div>
    ${parsed.valid ? `${walletRow()}<button class="button secondary" data-action="load-vault" ${busy ? "disabled" : ""}>Read live vault state</button>${controlPanel(parsed.invitation, vault)}` : ""}
  </section>`;
}

function controlPanel(invitation: RecoveryInvitation, snapshot?: VaultSnapshot): string {
  if (!snapshot) return `<section class="control-panel"><strong>Live controls</strong><p>Read vault ${short(invitation.vaultId)} to continue.</p><button class="button secondary" data-action="load-vault" ${busy ? "disabled" : ""}>Read live vault state</button></section>`;
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
  return `<section class="control-panel"><div class="control-heading"><div><strong>${current}</strong><p>Vault ${short(invitation.vaultId)} · epoch ${snapshot.epoch}</p></div><button class="text-button" data-action="load-vault">Refresh</button></div>
    <div class="metrics"><div><span>Reserve</span><strong>1 STRK</strong></div><div><span>${timingLabel}</span><strong>${timingValue}</strong></div></div>
    ${role === "owner" && current === "ACTIVE" ? `<button class="button primary" data-control="HEARTBEAT" ${!applicationKey || busy ? "disabled" : ""}>Send private heartbeat</button>` : ""}
    ${role === "owner" && current === "GRACE" ? `<button class="button primary" data-control="VETO" ${!applicationKey || busy ? "disabled" : ""}>Veto recovery</button>` : ""}
    ${role === "successor" && current === "ACTIVE" ? `<button class="button primary" data-control="REQUEST" ${!applicationKey || !requestReady || busy ? "disabled" : ""}>${requestReady ? "Request recovery" : "Request opens after inactivity"}</button>` : ""}
    ${role === "successor" && current === "GRACE" ? `<button class="button primary" ${claimReady && ready && applicationKey && !claimRetryBlocked ? "" : "disabled"} data-action="claim">${claimRetryBlocked ? "Claim awaiting reconciliation" : claimReady ? "Recover 1 STRK privately" : "Grace period is active"}</button>` : ""}
    <p class="action-help">Heartbeat, request and veto use your local signature through the neutral relayer. The Ready wallet address is not sent.</p>
  </section>`;
}

function statusPanel(): string {
  const parsed = parseInvitation(invitationText);
  const current = vault?.exists ? stateName(vault.state) : "Not loaded";
  return `<aside class="status-panel"><p class="status-label">Current vault</p><strong>${current}</strong><p>${parsed.valid ? short(parsed.invitation.vaultId) : "Create or import a reserve to read its live state."}</p>
    <div class="trace"><div><span>✓</span><p><strong>Funding relationship</strong><small>Unlinked by STRK20</small></p></div><div><span>✓</span><p><strong>Heartbeat and veto wallet</strong><small>Hidden behind signed neutral relay</small></p></div><div><span>✓</span><p><strong>Recovery destination</strong><small>Bound to one exact private note</small></p></div><div class="public"><span>○</span><p><strong>Timing and denomination</strong><small>Remain public</small></p></div></div>
    ${transactionHash ? `<a class="receipt" href="https://voyager.online/tx/${escapeHtml(transactionHash)}" target="_blank" rel="noreferrer">View latest Mainnet receipt ↗</a>` : ""}
    <details><summary>Truthful privacy boundary</summary><p>The contract, token, fixed denomination, application public keys, timing and state changes remain public. Ready wallet relationships and later private-note activity stay unlinked.</p></details></aside>`;
}

function render(): void {
  app.innerHTML = `<header class="site-header"><a class="brand" href="/"><span>◐</span>Afterlight</a><div class="network"><span></span>Starknet Mainnet</div></header>
  <main id="main"><section class="intro"><p class="kicker">Private recovery, under your control</p><h1>A reserve for the person you trust—without publishing the relationship.</h1><p>Heartbeat while active. Veto during grace. Only the designated successor key can authorize private recovery.</p></section>
  <nav class="role-tabs" aria-label="Choose your role"><button data-role="owner" aria-current="${role === "owner" ? "page" : "false"}">I’m the owner</button><button data-role="successor" aria-current="${role === "successor" ? "page" : "false"}">I’m the successor</button></nav>
  <div class="content-grid">${role === "owner" ? ownerView() : successorView()}${statusPanel()}</div></main>
  <div class="notice" role="status" aria-live="polite" data-busy="${busy}">${busy ? "Working… " : ""}${escapeHtml(notice)}</div>
  <footer><span>Afterlight is a recovery tool, not legal inheritance automation.</span><a href="https://github.com/dolepee/afterlight">Open-source contract</a></footer>`;
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
    if (submit) submit.disabled = !(walletStatus === "connected" && privateBalance !== undefined && privateBalance >= 7n * 10n ** 18n && applicationKey && /^0x[0-9a-f]{1,64}$/i.test(successorPublicKey));
  });
  document.querySelector<HTMLInputElement>("[name=cost-ack]")?.addEventListener("change", (event) => {
    costAcknowledged = (event.currentTarget as HTMLInputElement).checked;
  });
  document.querySelector<HTMLTextAreaElement>("[name=invitation]")?.addEventListener("input", (event) => {
    invitationText = (event.currentTarget as HTMLTextAreaElement).value;
    localStorage.setItem("afterlight:invitation:v1", invitationText);
    vault = undefined;
    render();
  });
  document.querySelector<HTMLFormElement>("#reserve-form")?.addEventListener("submit", (event) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget as HTMLFormElement);
    void run(async () => {
      if (!form.has("cost-ack") || !costAcknowledged) throw new Error("Confirm the exact 7 STRK private-wallet consequence first.");
      if (!ready || !applicationKey) throw new Error("Connect Ready X and generate the owner key first.");
      if (privateBalance === undefined || privateBalance < 7n * 10n ** 18n) throw new Error("At least 7 private STRK is required.");
      notice = "Requesting a fresh neutral funding checkpoint…"; render();
      const result = await fundRecoveryDrill({ ready, ownerKey: applicationKey, successorKey: successorPublicKey,
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
    if (num.toHex(BigInt(vault.successorKey)) !== num.toHex(BigInt(parsed.invitation.successorKey))) throw new Error("Invitation successor key does not match Mainnet state.");
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
  document.querySelector<HTMLButtonElement>("[data-action=claim]")?.addEventListener("click", () => void run(async () => {
    const parsed = parseInvitation(invitationText);
    if (!parsed.valid || !vault || !ready || !applicationKey) throw new Error("Connect Ready X and restore the designated successor key first.");
    const balanceBefore = await ready.balance(STRK);
    notice = "Ready X will prepare the exact private destination twice, then the neutral sponsor will submit it. The sponsor pays the pool and network fees."; render();
    const claimPackage = await prepareClaimPackage({ ready, invitation: parsed.invitation, vault, successorKey: applicationKey });
    notice = "Exact destination and designated-key authorization verified. Submitting through the neutral sponsor…"; render();
    let result;
    try {
      result = await submitClaimPackage(claimPackage);
    } catch (error) {
      if (error instanceof Error && error.message.includes("needs receipt reconciliation")) claimRetryBlocked = true;
      throw error;
    }
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
  const detection = detectReady();
  walletStatus = detection.found ? "available" : "missing";
  notice = detection.found ? `Ready X ${detection.version ?? ""} detected. No wallet request was made.` : "Ready X was not detected. You can still inspect and import a recovery invitation.";
});

window.addEventListener("beforeunload", () => applicationKey?.destroy());
