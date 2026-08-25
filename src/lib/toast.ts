export type ToastKind = "success" | "error" | "info";

export function notify(message: string, kind: ToastKind = "success") {
  window.dispatchEvent(
    new CustomEvent("yepo-toast", { detail: { message, kind } }),
  );
}
