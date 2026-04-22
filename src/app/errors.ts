const TOAST_REGION_ID = "napkin-toast-region";
const TOAST_TIMEOUT_MS = 4200;

type ReportLevel = "error" | "warn";

export interface ReportOptions {
  readonly level?: ReportLevel;
  readonly toast?: boolean;
  readonly sticky?: boolean;
  readonly toastMessage?: string;
}

export interface ErrorReporter {
  installGlobalHandlers(): void;
  report(context: string, error: unknown, options?: ReportOptions): void;
}

export function createErrorReporter(
  win: Window,
  doc: Document,
): ErrorReporter {
  let globalHandlersInstalled = false;

  function ensureToastRegion(): HTMLDivElement {
    const existingRegion = doc.getElementById(TOAST_REGION_ID);
    if (existingRegion instanceof HTMLDivElement) {
      return existingRegion;
    }

    const region = doc.createElement("div");
    region.id = TOAST_REGION_ID;
    region.className = "napkin-toast-region";
    doc.body.appendChild(region);
    return region;
  }

  function dismissToast(toast: HTMLDivElement): void {
    toast.classList.add("is-dismissing");
    win.setTimeout(() => toast.remove(), 140);
  }

  function showToast(message: string, sticky: boolean): void {
    const region = ensureToastRegion();
    const toast = doc.createElement("div");
    toast.className = "napkin-toast";
    toast.role = "alert";

    const messageElement = doc.createElement("div");
    messageElement.className = "napkin-toast-message";
    messageElement.textContent = message;

    const closeButton = doc.createElement("button");
    closeButton.className = "napkin-toast-close";
    closeButton.type = "button";
    closeButton.setAttribute("aria-label", "Dismiss error");
    closeButton.textContent = "×";
    closeButton.addEventListener("click", () => dismissToast(toast));

    toast.append(messageElement, closeButton);
    region.appendChild(toast);

    if (!sticky) {
      win.setTimeout(() => dismissToast(toast), TOAST_TIMEOUT_MS);
    }
  }

  function formatError(error: unknown): string {
    if (error instanceof Error) {
      return error.stack ?? error.message;
    }
    if (typeof error === "string") {
      return error;
    }
    try {
      return JSON.stringify(error);
    } catch {
      return String(error);
    }
  }

  function summarizeError(error: unknown): string {
    const firstLine = formatError(error).split("\n", 1)[0]?.trim() ?? "";
    if (!firstLine) {
      return "Unknown error";
    }
    return firstLine.length > 160
      ? `${firstLine.slice(0, 157)}...`
      : firstLine;
  }

  function report(
    context: string,
    error: unknown,
    options: ReportOptions = {},
  ): void {
    const level = options.level ?? "error";
    const prefix = `[napkin/ui] ${context}`;
    const consoleMethod = level === "warn" ? console.warn : console.error;

    consoleMethod(prefix, error);

    if (options.toast) {
      showToast(
        options.toastMessage ?? `${context}: ${summarizeError(error)}`,
        options.sticky ?? false,
      );
    }
  }

  return {
    installGlobalHandlers() {
      if (globalHandlersInstalled) {
        return;
      }
      globalHandlersInstalled = true;

      win.addEventListener("error", (event) => {
        const location = `${event.filename}:${event.lineno}:${event.colno}`;
        report(`window error at ${location}`, event.error ?? event.message, {
          toast: true,
          toastMessage: `Unexpected error at ${location}`,
        });
      });

      win.addEventListener("unhandledrejection", (event) => {
        report("unhandled promise rejection", event.reason, {
          toast: true,
          toastMessage: "Unexpected promise rejection. Check the console.",
        });
      });
    },
    report,
  };
}
