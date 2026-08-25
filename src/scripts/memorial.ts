import Alpine from "alpinejs";
import { supabase } from "../lib/supabase";
import { notify } from "../lib/toast";

const maxImageBytes = 6 * 1024 ** 2;
const maxVideoBytes = 10 * 1024 ** 2;
const maxTotalBytes = 20 * 1024 ** 2;

type SelectedFile = {
  file: File;
  type: "image" | "video";
};

type Memory = {
  type: "photo" | "video";
  src: string;
  alt: string;
  by: string;
  text: string;
  size: "feature" | "tall" | "wide" | "normal";
  focus: string;
};

type Upload = {
  bucket: "pending-images" | "pending-videos";
  path: string;
  token: string;
};

declare global {
  interface Window {
    yepoTurnstileSiteKey?: string;
    turnstile?: {
      render: (container: string, options: Record<string, unknown>) => string;
      reset: (widgetId: string) => void;
    };
  }
}

async function webp(file: File) {
  const bitmap = await createImageBitmap(file, {
    imageOrientation: "from-image",
  });
  const scale = Math.min(1, 2560 / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);
  canvas.getContext("2d")?.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close();

  for (const quality of [0.84, 0.74]) {
    const blob = await new Promise<Blob | null>((resolve) =>
      canvas.toBlob(resolve, "image/webp", quality),
    );
    if (blob && blob.size <= maxImageBytes)
      return new File([blob], `${crypto.randomUUID()}.webp`, {
        type: "image/webp",
      });
  }
  throw new Error("No pudimos comprimir una imagen a menos de 6 MB.");
}

Alpine.data("memorial", () => ({
  memories: [] as Memory[],
  galleryLoading: false,
  filter: "all",
  expanded: false,
  galleryLimit: 6,
  modal: null as null | "share" | "view",
  selected: null as Memory | null,
  zoom: 1,
  panX: 0,
  panY: 0,
  dragging: false,
  lastPointerX: 0,
  lastPointerY: 0,
  message: "",
  senderName: "",
  sending: false,
  submissionStatus: "",
  submissionError: false,
  selectedFiles: [] as SelectedFile[],
  turnstileToken: "",
  turnstileWidget: "",
  previews: [] as {
    type: "image" | "video";
    url: string;
    name: string;
    failed: boolean;
  }[],
  get visible() {
    return this.filter === "all"
      ? this.memories
      : this.memories.filter((item: Memory) => item.type === this.filter);
  },
  get shown() {
    return this.visible.slice(0, this.expanded ? undefined : this.galleryLimit);
  },
  get hasOverflow() {
    return this.visible.length > this.galleryLimit;
  },
  async init() {
    this.mountTurnstile();
    if (!supabase) return;
    this.galleryLoading = true;
    const { data, error } = await supabase
      .from("submissions")
      .select("id, sender_name, message, media(*)")
      .eq("status", "approved")
      .order("created_at", { ascending: true });
    this.galleryLoading = false;
    if (error || !data) return;
    const sizes: Memory["size"][] = ["feature", "wide", "normal", "tall"];
    this.memories = data.flatMap((submission, submissionIndex) =>
      (submission.media ?? [])
        .filter((item) => item.published_bucket && item.published_path)
        .map((item, mediaIndex) => ({
          type: item.kind === "video" ? "video" : "photo",
          src: supabase.storage
            .from(item.published_bucket)
            .getPublicUrl(item.published_path).data.publicUrl,
          alt: submission.message || "Recuerdo compartido con cariño",
          by: submission.sender_name || "Alguien que lo recuerda",
          text: submission.message || "",
          size: sizes[(submissionIndex + mediaIndex) % sizes.length],
          focus: "50% 50%",
        })),
    );
  },
  mountTurnstile() {
    if (!window.yepoTurnstileSiteKey) return;
    const mount = () => {
      if (!window.turnstile || this.turnstileWidget) return;
      this.turnstileWidget = window.turnstile.render("#share-turnstile", {
        sitekey: window.yepoTurnstileSiteKey,
        theme: "dark",
        size: "flexible",
        action: "share_memory",
        callback: (token: string) => (this.turnstileToken = token),
        "expired-callback": () => (this.turnstileToken = ""),
        "error-callback": () => (this.turnstileToken = ""),
      });
    };
    if (window.turnstile) mount();
    else window.addEventListener("load", mount, { once: true });
  },
  resetTurnstile() {
    this.turnstileToken = "";
    if (this.turnstileWidget) window.turnstile?.reset(this.turnstileWidget);
  },
  open(memory: Memory) {
    this.selected = memory;
    this.resetView();
    this.modal = "view";
  },
  close() {
    this.modal = null;
    this.selected = null;
    this.previews.forEach((item) => URL.revokeObjectURL(item.url));
    this.previews = [];
    this.selectedFiles = [];
    this.submissionStatus = "";
    this.submissionError = false;
    this.resetTurnstile();
  },
  previous() {
    if (!this.selected) return;
    const index = this.visible.indexOf(this.selected);
    this.selected =
      this.visible[(index - 1 + this.visible.length) % this.visible.length];
    this.resetView();
  },
  next() {
    if (!this.selected) return;
    const index = this.visible.indexOf(this.selected);
    this.selected = this.visible[(index + 1) % this.visible.length];
    this.resetView();
  },
  resetView() {
    this.zoom = 1;
    this.panX = 0;
    this.panY = 0;
    this.dragging = false;
  },
  zoomBy(amount: number) {
    this.zoom = Math.max(1, Math.min(3, this.zoom + amount));
  },
  startPan(event: PointerEvent) {
    this.dragging = true;
    this.lastPointerX = event.clientX;
    this.lastPointerY = event.clientY;
    event.currentTarget.setPointerCapture(event.pointerId);
  },
  movePan(event: PointerEvent) {
    if (!this.dragging) return;
    this.panX += event.clientX - this.lastPointerX;
    this.panY += event.clientY - this.lastPointerY;
    this.lastPointerX = event.clientX;
    this.lastPointerY = event.clientY;
  },
  endPan() {
    this.dragging = false;
  },
  files(list: FileList) {
    const chosen = [...list];
    const valid =
      chosen.length <= 5 &&
      chosen.reduce((sum, file) => sum + file.size, 0) <= maxTotalBytes &&
      chosen.every((file) =>
        file.type.startsWith("image/")
          ? file.size <= 15 * 1024 ** 2
          : file.type === "video/mp4" && file.size <= maxVideoBytes,
      );
    if (!valid)
      return notify(
        "Máximo: 5 archivos, 20 MB por envío, imágenes de 15 MB y vídeos MP4 de 10 MB.",
        "error",
      );
    this.previews.forEach((item) => URL.revokeObjectURL(item.url));
    this.selectedFiles = chosen.map((file) => ({
      file,
      type: file.type.startsWith("image/") ? "image" : "video",
    }));
    this.previews = chosen.map((file) => ({
      type: file.type.startsWith("image/")
        ? ("image" as const)
        : ("video" as const),
      url: URL.createObjectURL(file),
      name: file.name,
      failed: false,
    }));
    notify(
      `${chosen.length} ${chosen.length === 1 ? "archivo listo" : "archivos listos"} para enviar.`,
      "info",
    );
  },
  async submit() {
    if (!this.selectedFiles.length)
      return notify("Elige al menos una foto o vídeo.", "error");
    if (!supabase) {
      this.submissionError = true;
      this.submissionStatus =
        "La conexión para enviar recuerdos no está configurada.";
      notify(this.submissionStatus, "error");
      return;
    }
    if (!this.turnstileToken)
      return notify(
        "Completa la verificación de seguridad antes de enviar.",
        "error",
      );
    this.sending = true;
    this.submissionStatus = "Preparando tus archivos…";
    this.submissionError = false;
    try {
      const files = await Promise.all(
        this.selectedFiles.map(async ({ file, type }) => ({
          file: type === "image" ? await webp(file) : file,
          type,
        })),
      );
      if (
        files.reduce((total, item) => total + item.file.size, 0) > maxTotalBytes
      )
        throw new Error(
          "Los archivos comprimidos superan los 20 MB por envío.",
        );

      const { data, error } = await supabase.functions.invoke("submit-memory", {
        body: {
          turnstileToken: this.turnstileToken,
          senderName: this.senderName.trim() || null,
          message: this.message.trim() || null,
          files: files.map(({ file, type }) => ({
            kind: type,
            mimeType: file.type,
            size: file.size,
          })),
        },
      });
      if (error) throw error;
      const uploads = data?.uploads as Upload[] | undefined;
      if (!uploads || uploads.length !== files.length)
        throw new Error("No pudimos autorizar la subida de archivos.");
      const results = await Promise.all(
        uploads.map((upload, index) =>
          supabase.storage
            .from(upload.bucket)
            .uploadToSignedUrl(upload.path, upload.token, files[index].file),
        ),
      );
      const failed = results.find((result) => result.error);
      if (failed?.error) throw failed.error;
      this.selectedFiles = [];
      this.previews.forEach((item) => URL.revokeObjectURL(item.url));
      this.previews = [];
      this.senderName = "";
      this.message = "";
      this.submissionStatus =
        "Tu recuerdo fue enviado a revisión. Gracias por compartirlo.";
      notify(this.submissionStatus);
    } catch (error) {
      this.submissionError = true;
      this.submissionStatus =
        error instanceof Error
          ? error.message
          : "No pudimos enviar el recuerdo. Inténtalo de nuevo.";
      notify(this.submissionStatus, "error");
    } finally {
      this.sending = false;
      this.resetTurnstile();
    }
  },
}));
