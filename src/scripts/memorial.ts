import Alpine from "alpinejs";
import { FunctionsHttpError } from "@supabase/supabase-js";
import { supabase } from "../lib/supabase";
import { notify } from "../lib/toast";

const maxImageBytes = 3 * 1024 ** 2;
const maxVideoBytes = 30 * 1024 ** 2;
const maxTotalBytes = 60 * 1024 ** 2;
const maxImageInputBytes = 15 * 1024 ** 2;
const supportedImageTypes = new Set(["image/jpeg", "image/png", "image/webp"]);

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
  poster?: string;
  posterObjectUrl?: boolean;
  posterSeeking?: boolean;
  posterFailed?: boolean;
  videoReady?: boolean;
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
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file, { imageOrientation: "from-image" });
  } catch {
    throw new Error(`No pudimos leer “${file.name}”. Usa JPG, PNG o WebP.`);
  }
  const scale = Math.min(1, 2048 / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);
  canvas.getContext("2d")?.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close();

  for (const quality of [0.8, 0.7, 0.6]) {
    const blob = await new Promise<Blob | null>((resolve) =>
      canvas.toBlob(resolve, "image/webp", quality),
    );
    if (blob && blob.size <= maxImageBytes)
      return new File([blob], `${crypto.randomUUID()}.webp`, {
        type: "image/webp",
      });
  }
  throw new Error("No pudimos comprimir una imagen a menos de 3 MB.");
}

Alpine.data("memorial", () => ({
  memories: [] as Memory[],
  galleryLoading: false,
  strollPhoto: null as Memory | null,
  strollRevision: 0,
  strollTimer: 0 as number | undefined,
  filter: "all",
  expanded: false,
  galleryLimit: 10,
  modal: null as null | "share" | "view",
  selected: null as Memory | null,
  zoom: 1,
  panX: 0,
  panY: 0,
  dragging: false,
  lastPointerX: 0,
  lastPointerY: 0,
  pointers: new Map<number, { x: number; y: number }>(),
  pinchDistance: 0,
  pinchZoom: 1,
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
  get zoomPercent() {
    return `${Math.round(this.zoom * 100)}%`;
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
    this.memories.forEach((memory) => {
      if (memory.posterObjectUrl && memory.poster)
        URL.revokeObjectURL(memory.poster);
    });
    const sizes: Memory["size"][] = [
      "feature",
      "wide",
      "normal",
      "wide",
      "normal",
    ];
    this.memories = data.flatMap((submission, submissionIndex) =>
      (submission.media ?? [])
        .filter((item) => item.published_bucket && item.published_path)
        .map((item, mediaIndex) => ({
          type: item.kind === "video" ? "video" : "photo",
          src: supabase.storage
            .from(item.published_bucket)
            .getPublicUrl(item.published_path).data.publicUrl,
          poster:
            item.poster_bucket && item.poster_path
              ? supabase.storage
                  .from(item.poster_bucket)
                  .getPublicUrl(item.poster_path).data.publicUrl
              : undefined,
          alt: submission.message || "Recuerdo compartido con cariño",
          by: submission.sender_name || "Alguien que lo recuerda",
          text: submission.message || "",
          size: sizes[(submissionIndex + mediaIndex) % sizes.length],
          focus: "50% 50%",
        })),
    );
    this.startPhotoStroll();
    document.addEventListener("visibilitychange", () => this.syncPhotoStroll());
    window.addEventListener("pagehide", () => this.stopPhotoStroll(), {
      once: true,
    });
  },
  get strollPhotos() {
    return this.memories.filter((memory: Memory) => memory.type === "photo");
  },
  nextPhotoStroll() {
    const photos = this.strollPhotos;
    if (!photos.length) return (this.strollPhoto = null);
    const choices =
      photos.length > 1
        ? photos.filter((photo: Memory) => photo.src !== this.strollPhoto?.src)
        : photos;
    this.strollPhoto = choices[Math.floor(Math.random() * choices.length)];
    this.strollRevision += 1;
  },
  stopPhotoStroll() {
    if (this.strollTimer) window.clearInterval(this.strollTimer);
    this.strollTimer = undefined;
  },
  startPhotoStroll() {
    this.stopPhotoStroll();
    this.nextPhotoStroll();
    if (
      this.strollPhotos.length > 1 &&
      document.visibilityState === "visible" &&
      !window.matchMedia("(prefers-reduced-motion: reduce)").matches
    )
      this.strollTimer = window.setInterval(() => this.nextPhotoStroll(), 2000);
  },
  syncPhotoStroll() {
    if (document.visibilityState === "visible") this.startPhotoStroll();
    else this.stopPhotoStroll();
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
    this.pointers.clear();
    this.pinchDistance = 0;
    this.pinchZoom = 1;
  },
  zoomBy(amount: number) {
    this.zoom = Math.max(1, Math.min(3, this.zoom + amount));
    if (this.zoom === 1) this.panX = this.panY = 0;
  },
  startPan(event: PointerEvent) {
    this.pointers.set(event.pointerId, {
      x: event.clientX,
      y: event.clientY,
    });
    this.dragging = true;
    this.lastPointerX = event.clientX;
    this.lastPointerY = event.clientY;
    event.currentTarget.setPointerCapture(event.pointerId);
    if (this.pointers.size === 2) {
      this.dragging = false;
      this.pinchDistance = this.currentPinchDistance();
      this.pinchZoom = this.zoom;
    }
  },
  movePan(event: PointerEvent) {
    if (!this.pointers.has(event.pointerId)) return;
    this.pointers.set(event.pointerId, {
      x: event.clientX,
      y: event.clientY,
    });
    if (this.pointers.size === 2 && this.pinchDistance) {
      this.zoom = Math.max(
        1,
        Math.min(
          3,
          this.pinchZoom * (this.currentPinchDistance() / this.pinchDistance),
        ),
      );
      return;
    }
    if (!this.dragging) return;
    this.panX += event.clientX - this.lastPointerX;
    this.panY += event.clientY - this.lastPointerY;
    this.lastPointerX = event.clientX;
    this.lastPointerY = event.clientY;
  },
  endPan(event: PointerEvent) {
    this.pointers.delete(event.pointerId);
    this.pinchDistance = 0;
    if (this.pointers.size === 1) {
      const pointer = this.pointers.values().next().value;
      this.dragging = true;
      this.lastPointerX = pointer.x;
      this.lastPointerY = pointer.y;
      return;
    }
    this.dragging = false;
  },
  currentPinchDistance() {
    const [first, second] = [...this.pointers.values()];
    return Math.hypot(second.x - first.x, second.y - first.y);
  },
  captureVideoPoster(memory: Memory, event: Event) {
    if (memory.poster || memory.posterFailed) return;
    const video = event.currentTarget as HTMLVideoElement;
    if (!video.videoWidth || !video.videoHeight)
      return this.markVideoPosterFailed(memory);
    if (
      !memory.posterSeeking &&
      Number.isFinite(video.duration) &&
      video.duration > 1
    ) {
      memory.posterSeeking = true;
      video.currentTime = Math.min(1, video.duration / 2);
      return;
    }

    const scale = Math.min(
      1,
      960 / Math.max(video.videoWidth, video.videoHeight),
    );
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(video.videoWidth * scale);
    canvas.height = Math.round(video.videoHeight * scale);
    const context = canvas.getContext("2d");
    if (!context) return this.markVideoPosterFailed(memory);

    try {
      context.drawImage(video, 0, 0, canvas.width, canvas.height);
      canvas.toBlob(
        (blob) => {
          if (!blob) return this.markVideoPosterFailed(memory);
          memory.poster = URL.createObjectURL(blob);
          memory.posterObjectUrl = true;
        },
        "image/webp",
        0.72,
      );
    } catch {}
  },
  markVideoPosterFailed(memory: Memory) {
    memory.posterFailed = true;
  },
  scheduleVideoFallback(memory: Memory) {
    window.setTimeout(() => {
      if (!memory.videoReady && !memory.poster)
        this.markVideoPosterFailed(memory);
    }, 2500);
  },
  clearBrokenPoster(memory: Memory) {
    if (memory.type !== "video") return;
    if (memory.posterObjectUrl && memory.poster)
      URL.revokeObjectURL(memory.poster);
    memory.poster = undefined;
    memory.posterObjectUrl = false;
  },
  files(list: FileList) {
    const chosen = [...list];
    if (chosen.length > 5)
      return notify("Puedes seleccionar un máximo de 5 archivos.", "error");
    const invalidType = chosen.find(
      (file) =>
        !supportedImageTypes.has(file.type) && file.type !== "video/mp4",
    );
    if (invalidType)
      return notify(
        `“${invalidType.name}” no es compatible. Usa JPG, PNG, WebP o MP4.`,
        "error",
      );
    const oversized = chosen.find(
      (file) =>
        (supportedImageTypes.has(file.type) &&
          file.size > maxImageInputBytes) ||
        (file.type === "video/mp4" && file.size > maxVideoBytes),
    );
    if (oversized)
      return notify(
        `“${oversized.name}” supera el límite: fotos 15 MB y vídeos 30 MB.`,
        "error",
      );
    if (chosen.reduce((sum, file) => sum + file.size, 0) > maxTotalBytes)
      return notify("El envío completo no puede superar los 60 MB.", "error");
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
        throw new Error("Los archivos preparados superan los 60 MB por envío.");

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
      if (error instanceof FunctionsHttpError) {
        const body = await error.context.json().catch(() => null);
        throw new Error(
          typeof body?.error === "string"
            ? body.error
            : "No pudimos preparar el envío.",
        );
      }
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
