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
  dispose(): Promise<void>;
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

  let currentDiffId: string | null = null;

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

  const show = (event: DiffPromptEvent) => {
    currentDiffId = event.diffId;
    title.textContent = event.title ?? "Agent diff";
    const lines = event.diff.split("\n").length;
    meta.textContent = `${lines} line${lines === 1 ? "" : "s"}`;
    renderDiff(event.diff);
    root.hidden = false;
    doc.addEventListener("keydown", onKeyDown, true);
    queueMicrotask(() => acceptBtn.focus());
  };

  const decide = async (accepted: boolean) => {
    if (!currentDiffId) {
      hide();
      return;
    }
    const diffId = currentDiffId;
    hide();
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
    currentDiffId = null;
    doc.removeEventListener("keydown", onKeyDown, true);
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

  acceptBtn.addEventListener("click", () => void decide(true));
  rejectBtn.addEventListener("click", () => void decide(false));

  const unlisten: UnlistenFn = await listen<{
    readonly session_id: string;
    readonly diff_id: string;
    readonly diff: string;
    readonly title: string | null;
  }>("pane-diff-prompt", ({ payload }) => {
    show({
      sessionId: payload.session_id,
      diffId: payload.diff_id,
      diff: payload.diff,
      title: payload.title,
    });
  });

  return {
    async dispose() {
      hide();
      unlisten();
    },
  };
}
