//! Diff preview overlay. Shown when an agent calls `napkin diff` to submit
//! a unified diff for approval. Enter accepts, Esc rejects; the decision
//! flows back through napkind to the CLI waiter.

import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

interface DiffPromptEvent {
  readonly sessionId: string;
  readonly diffId: string;
  readonly diff: string;
  readonly title: string | null;
}

export interface DiffOverlay {
  toggleInbox(): void;
  pendingCount(): number;
  dispose(): Promise<void>;
}

type DiffInboxStatus = "pending" | "accepted" | "rejected";

interface DiffInboxItem extends DiffPromptEvent {
  status: DiffInboxStatus;
  receivedAt: number;
}

export async function createDiffOverlay(doc: Document): Promise<DiffOverlay> {
  const root = doc.createElement("div");
  root.className = "napkin-diff";
  root.hidden = true;
  root.setAttribute("role", "dialog");
  root.setAttribute("aria-modal", "true");

  const backdrop = doc.createElement("div");
  backdrop.className = "napkin-diff-backdrop";

  const frame = doc.createElement("div");
  frame.className = "napkin-diff-frame";

  const header = doc.createElement("div");
  header.className = "napkin-diff-header";

  const title = doc.createElement("span");
  title.className = "napkin-diff-title";

  const meta = doc.createElement("span");
  meta.className = "napkin-diff-meta";

  header.append(title, meta);

  const body = doc.createElement("pre");
  body.className = "napkin-diff-body";

  const actions = doc.createElement("div");
  actions.className = "napkin-diff-actions";

  const rejectBtn = doc.createElement("button");
  rejectBtn.type = "button";
  rejectBtn.className = "napkin-diff-button napkin-diff-reject";
  rejectBtn.textContent = "Reject · Esc";

  const acceptBtn = doc.createElement("button");
  acceptBtn.type = "button";
  acceptBtn.className = "napkin-diff-button napkin-diff-accept";
  acceptBtn.textContent = "Accept · ↵";

  actions.append(rejectBtn, acceptBtn);

  frame.append(header, body, actions);
  backdrop.appendChild(frame);
  root.appendChild(backdrop);
  doc.body.appendChild(root);

  const inboxRoot = doc.createElement("div");
  inboxRoot.className = "napkin-diff-inbox";
  inboxRoot.hidden = true;
  inboxRoot.setAttribute("role", "dialog");
  inboxRoot.setAttribute("aria-modal", "true");
  inboxRoot.setAttribute("aria-label", "Diff inbox");

  const inboxBackdrop = doc.createElement("div");
  inboxBackdrop.className = "napkin-diff-backdrop";
  inboxBackdrop.addEventListener("mousedown", (event) => {
    if (event.target === inboxBackdrop) closeInbox();
  });

  const inboxFrame = doc.createElement("div");
  inboxFrame.className = "napkin-diff-inbox-frame";

  const inboxHeader = doc.createElement("div");
  inboxHeader.className = "napkin-diff-header";

  const inboxTitle = doc.createElement("span");
  inboxTitle.className = "napkin-diff-title";
  inboxTitle.textContent = "Diff inbox";

  const inboxMeta = doc.createElement("span");
  inboxMeta.className = "napkin-diff-meta";

  inboxHeader.append(inboxTitle, inboxMeta);

  const inboxList = doc.createElement("div");
  inboxList.className = "napkin-diff-inbox-list";

  const inboxEmpty = doc.createElement("div");
  inboxEmpty.className = "napkin-diff-inbox-empty";
  inboxEmpty.textContent = "No agent diffs yet.";

  inboxFrame.append(inboxHeader, inboxList, inboxEmpty);
  inboxBackdrop.appendChild(inboxFrame);
  inboxRoot.appendChild(inboxBackdrop);
  doc.body.appendChild(inboxRoot);

  let currentItem: DiffInboxItem | null = null;
  const items: DiffInboxItem[] = [];

  const renderDiff = (diff: string) => {
    body.replaceChildren();
    for (const line of diff.split("\n")) {
      const el = doc.createElement("span");
      el.className = "napkin-diff-line";
      if (line.startsWith("+++") || line.startsWith("---")) {
        el.classList.add("file");
      } else if (line.startsWith("@@")) {
        el.classList.add("hunk");
      } else if (line.startsWith("+")) {
        el.classList.add("add");
      } else if (line.startsWith("-")) {
        el.classList.add("del");
      }
      el.textContent = line;
      body.appendChild(el);
      body.appendChild(doc.createTextNode("\n"));
    }
  };

  const showItem = (item: DiffInboxItem) => {
    currentItem = item;
    closeInbox();
    title.textContent = item.title ?? "Agent diff";
    const lines = item.diff.split("\n").length;
    meta.textContent = `${lines} line${lines === 1 ? "" : "s"}`;
    renderDiff(item.diff);
    root.hidden = false;
    doc.addEventListener("keydown", onKeyDown, true);
    queueMicrotask(() => acceptBtn.focus());
  };

  const decide = async (accepted: boolean) => {
    if (!currentItem) {
      hide();
      return;
    }
    const item = currentItem;
    const diffId = item.diffId;
    item.status = accepted ? "accepted" : "rejected";
    hide();
    renderInbox();
    try {
      await invoke("diff_decide", { diffId, accepted });
    } catch (error) {
      // Swallow — the CLI will time out or see a broken channel; we can't
      // do anything actionable here beyond surfacing to the user.
      console.warn("[napkin/diff] decide failed", error);
    }
  };

  const hide = () => {
    if (root.hidden) return;
    root.hidden = true;
    currentItem = null;
    doc.removeEventListener("keydown", onKeyDown, true);
  };

  const renderInbox = () => {
    const pending = items.filter((item) => item.status === "pending").length;
    inboxMeta.textContent =
      `${items.length} total / ${pending} pending`;

    inboxList.replaceChildren();
    inboxList.hidden = items.length === 0;
    inboxEmpty.hidden = items.length > 0;

    for (const item of items) {
      const row = doc.createElement("div");
      row.className = "napkin-diff-inbox-row";
      row.dataset.status = item.status;

      const main = doc.createElement("button");
      main.type = "button";
      main.className = "napkin-diff-inbox-main";
      main.addEventListener("click", () => showItem(item));

      const rowTitle = doc.createElement("span");
      rowTitle.className = "napkin-diff-inbox-title";
      rowTitle.textContent = item.title ?? "Agent diff";

      const lines = item.diff.split("\n").length;
      const rowMeta = doc.createElement("span");
      rowMeta.className = "napkin-diff-inbox-row-meta";
      rowMeta.textContent = `${lines} line${lines === 1 ? "" : "s"} / ${new Date(item.receivedAt).toLocaleTimeString([], {
        hour: "2-digit",
        minute: "2-digit",
      })}`;

      main.append(rowTitle, rowMeta);

      const status = doc.createElement("span");
      status.className = "napkin-diff-inbox-status";
      status.textContent = item.status;

      const view = doc.createElement("button");
      view.type = "button";
      view.className = "napkin-diff-button";
      view.textContent = item.status === "pending" ? "Review" : "View";
      view.addEventListener("click", () => showItem(item));

      row.append(main, status, view);
      inboxList.appendChild(row);
    }
  };

  const openInbox = () => {
    renderInbox();
    if (!root.hidden) hide();
    if (!inboxRoot.hidden) return;
    inboxRoot.hidden = false;
    doc.addEventListener("keydown", onInboxKeyDown, true);
  };

  const closeInbox = () => {
    if (inboxRoot.hidden) return;
    inboxRoot.hidden = true;
    doc.removeEventListener("keydown", onInboxKeyDown, true);
  };

  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key === "Escape") {
      event.preventDefault();
      void decide(false);
      return;
    }
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      void decide(true);
    }
  };

  const onInboxKeyDown = (event: KeyboardEvent) => {
    if (event.key === "Escape") {
      event.preventDefault();
      closeInbox();
    }
  };

  acceptBtn.addEventListener("click", () => void decide(true));
  rejectBtn.addEventListener("click", () => void decide(false));

  const unlisten: UnlistenFn = await listen<{
    readonly session_id: string;
    readonly diff_id: string;
    readonly diff: string;
    readonly title: string | null;
  }>("pane-diff-prompt", ({ payload }) => {
    const item: DiffInboxItem = {
      sessionId: payload.session_id,
      diffId: payload.diff_id,
      diff: payload.diff,
      title: payload.title,
      status: "pending",
      receivedAt: Date.now(),
    };
    const existingIndex = items.findIndex((candidate) => candidate.diffId === item.diffId);
    if (existingIndex >= 0) {
      items.splice(existingIndex, 1);
    }
    items.unshift(item);
    if (items.length > 100) {
      items.splice(100);
    }
    renderInbox();
    showItem(item);
  });

  return {
    toggleInbox() {
      if (inboxRoot.hidden) openInbox();
      else closeInbox();
    },
    pendingCount() {
      return items.filter((item) => item.status === "pending").length;
    },
    async dispose() {
      hide();
      closeInbox();
      unlisten();
    },
  };
}
