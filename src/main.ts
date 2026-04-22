import "@xterm/xterm/css/xterm.css";
import "./styles.css";

import { createErrorReporter } from "./app/errors.ts";
import { bootWorkspace } from "./app/workspace.ts";
import type { AppElements } from "./app/types.ts";

function requireDivElement(id: string): HTMLDivElement {
  const element = document.getElementById(id);
  if (!(element instanceof HTMLDivElement)) {
    throw new Error(`expected #${id} to be a div`);
  }
  return element;
}

function requireButtonElement(id: string): HTMLButtonElement {
  const element = document.getElementById(id);
  if (!(element instanceof HTMLButtonElement)) {
    throw new Error(`expected #${id} to be a button`);
  }
  return element;
}

function getAppElements(): AppElements {
  return {
    container: requireDivElement("term"),
    tabStrip: requireDivElement("tab-strip"),
    newTabButton: requireButtonElement("new-tab"),
  };
}

const reporter = createErrorReporter(window, document);
reporter.installGlobalHandlers();

void bootWorkspace(getAppElements(), reporter).catch((error) => {
  reporter.report("boot failed", error, {
    toast: true,
    sticky: true,
  });
});
