import Alpine from "alpinejs";
import { supabase } from "../lib/supabase";
import { notify } from "../lib/toast";

const r2PublicUrl = "https://media.yepo.dev";

const mediaUrl = (path: string) =>
  `${r2PublicUrl}/${path.split("/").map(encodeURIComponent).join("/")}`;

declare global {
  interface Window {
    yepoTurnstileSiteKey?: string;
    turnstile?: {
      render: (container: string, options: Record<string, unknown>) => string;
      reset: (widgetId: string) => void;
    };
  }
}

type PendingMedia = {
  id: string;
  kind: "image" | "video";
  pending_bucket: "pending-images" | "pending-videos";
  pending_path: string;
  mime_type: string;
  url: string;
};

type PendingSubmission = {
  id: string;
  sender_name: string | null;
  message: string | null;
  media: PendingMedia[];
};

type PublishedMedia = {
  id: string;
  kind: "image" | "video";
  published_bucket: "gallery-images" | "gallery-videos" | null;
  published_path: string | null;
  poster_bucket: "gallery-images" | null;
  poster_path: string | null;
  r2_path: string | null;
  r2_poster_path: string | null;
  url: string;
  poster: string;
};

type PublishedSubmission = {
  id: string;
  sender_name: string | null;
  message: string | null;
  created_at: string;
  media: PublishedMedia[];
};

Alpine.data("management", () => ({
  state: "checking" as "checking" | "guest" | "admin",
  email: "",
  password: "",
  busy: false,
  starting: false,
  message: "",
  isError: false,
  userId: "",
  tab: "pending" as "pending" | "published",
  submissions: [] as PendingSubmission[],
  published: [] as PublishedSubmission[],
  editingId: "",
  turnstileToken: "",
  turnstileWidget: "",
  async init() {
    this.mountTurnstile();
    if (!supabase) {
      this.state = "guest";
      this.isError = true;
      this.message = "La conexión no está configurada.";
      return;
    }
    const { data } = await supabase.auth.getUser();
    if (!data.user) return (this.state = "guest");
    await this.verifyAdmin(data.user.id);
  },
  mountTurnstile() {
    if (!window.yepoTurnstileSiteKey) return;
    const mount = () => {
      if (!window.turnstile || this.turnstileWidget) return;
      this.turnstileWidget = window.turnstile.render("#login-turnstile", {
        sitekey: window.yepoTurnstileSiteKey,
        theme: "dark",
        size: "flexible",
        action: "admin_login",
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
  async signIn() {
    if (!supabase) return;
    this.busy = true;
    this.starting = true;
    this.message = "";
    const minimumWait = new Promise((resolve) => setTimeout(resolve, 2000));
    const { data, error } = await supabase.auth.signInWithPassword({
      email: this.email,
      password: this.password,
      options: { captchaToken: this.turnstileToken },
    });
    await minimumWait;
    this.resetTurnstile();
    if (error || !data.user)
      return this.stopStarting("No fue posible acceder con esas credenciales.");
    this.password = "";
    await this.verifyAdmin(data.user.id);
    this.starting = false;
    this.busy = false;
    if (this.state === "admin") notify("Sesión iniciada correctamente.");
  },
  async verifyAdmin(userId: string) {
    if (!supabase) return;
    const { data } = await supabase
      .from("admin_users")
      .select("user_id")
      .eq("user_id", userId)
      .maybeSingle();
    if (!data) {
      await supabase.auth.signOut();
      return this.fail("Esta cuenta no tiene acceso a la gestión.");
    }
    this.userId = userId;
    this.state = "admin";
    await this.loadPending();
  },
  async setTab(tab: "pending" | "published") {
    this.tab = tab;
    this.editingId = "";
    this.message = "";
    if (tab === "published") await this.loadPublished();
  },
  async loadPending() {
    if (!supabase) return;
    this.busy = true;
    const { data, error } = await supabase
      .from("submissions")
      .select(
        "id, sender_name, message, media(id, kind, pending_bucket, pending_path, mime_type)",
      )
      .eq("status", "pending")
      .order("created_at", { ascending: true });
    this.busy = false;
    if (error || !data)
      return this.fail("No pudimos cargar los recuerdos pendientes.");
    this.submissions = await Promise.all(
      data.map(async (submission) => ({
        ...submission,
        media: await Promise.all(
          submission.media.map(async (item) => {
            const { data: signed } = await supabase.storage
              .from(item.pending_bucket)
              .createSignedUrl(item.pending_path, 300);
            return { ...item, url: signed?.signedUrl ?? "" };
          }),
        ),
      })),
    );
  },
  async loadPublished() {
    if (!supabase) return;
    this.busy = true;
    const { data, error } = await supabase
      .from("submissions")
      .select(
        "id, sender_name, message, created_at, media(id, kind, published_bucket, published_path, poster_bucket, poster_path, r2_path, r2_poster_path)",
      )
      .eq("status", "approved")
      .order("created_at", { ascending: false });
    this.busy = false;
    if (error || !data) {
      this.isError = true;
      this.message = "No pudimos cargar los recuerdos publicados.";
      return notify(this.message, "error");
    }
    this.published = data.map((submission) => ({
      ...submission,
      media: submission.media
        .filter(
          (item) =>
            item.r2_path || (item.published_bucket && item.published_path),
        )
        .map((item) => ({
          ...item,
          url: item.r2_path
            ? mediaUrl(item.r2_path)
            : supabase.storage
                .from(item.published_bucket!)
                .getPublicUrl(item.published_path!).data.publicUrl,
          poster: item.r2_poster_path
            ? mediaUrl(item.r2_poster_path)
            : item.poster_bucket && item.poster_path
              ? supabase.storage
                  .from(item.poster_bucket)
                  .getPublicUrl(item.poster_path).data.publicUrl
              : "",
        })),
    }));
  },
  async review(submission: PendingSubmission, status: "approved" | "rejected") {
    if (!supabase) return;
    this.busy = true;
    this.message = "";
    try {
      if (status === "approved") {
        for (const item of submission.media)
          await this.publish(item, submission.id);
      }
      const { error } = await supabase
        .from("submissions")
        .update({
          status,
          reviewed_by: this.userId,
          reviewed_at: new Date().toISOString(),
        })
        .eq("id", submission.id);
      if (error) throw error;
      for (const item of submission.media) {
        await supabase.storage
          .from(item.pending_bucket)
          .remove([item.pending_path]);
      }
      await this.loadPending();
      this.message =
        status === "approved"
          ? "Recuerdo publicado."
          : "Recuerdo rechazado y eliminado.";
      this.isError = false;
      notify(this.message);
    } catch {
      this.isError = true;
      this.message = "No pudimos completar la revisión. Inténtalo de nuevo.";
      notify(this.message, "error");
    } finally {
      this.busy = false;
    }
  },
  async publish(item: PendingMedia, submissionId: string) {
    if (!supabase) return;
    const { error } = await supabase.functions.invoke("manage-media", {
      body: { action: "publish", mediaId: item.id, submissionId },
    });
    if (error) throw error;
  },
  async savePublished(submission: PublishedSubmission) {
    if (!supabase) return;
    const senderName = submission.sender_name?.trim() || null;
    const message = submission.message?.trim() || null;
    if ((senderName?.length ?? 0) > 60 || (message?.length ?? 0) > 300)
      return notify("El nombre o mensaje supera el límite permitido.", "error");
    this.busy = true;
    const { error } = await supabase
      .from("submissions")
      .update({ sender_name: senderName, message })
      .eq("id", submission.id);
    this.busy = false;
    if (error) return notify("No pudimos guardar los cambios.", "error");
    this.editingId = "";
    notify("Cambios guardados.");
  },
  toggleEditor(submissionId: string) {
    this.editingId = this.editingId === submissionId ? "" : submissionId;
  },
  formatDate(value: string) {
    return new Intl.DateTimeFormat("es-PA", {
      day: "2-digit",
      month: "short",
      year: "numeric",
    }).format(new Date(value));
  },
  async deletePublished(submission: PublishedSubmission) {
    if (!supabase) return;
    if (
      !window.confirm(
        "Eliminar este recuerdo y todos sus archivos? Esta acción no se puede deshacer.",
      )
    )
      return;
    this.busy = true;
    try {
      const filesByBucket = new Map<string, string[]>();
      for (const item of submission.media) {
        for (const [bucket, path] of [
          [item.published_bucket, item.published_path],
          [item.poster_bucket, item.poster_path],
        ] as const) {
          if (!bucket || !path) continue;
          filesByBucket.set(bucket, [
            ...(filesByBucket.get(bucket) ?? []),
            path,
          ]);
        }
      }
      for (const [bucket, paths] of filesByBucket) {
        const { error } = await supabase.storage.from(bucket).remove(paths);
        if (error) throw error;
      }
      for (const item of submission.media) {
        if (!item.r2_path) continue;
        const { error } = await supabase.functions.invoke("manage-media", {
          body: { action: "delete", mediaId: item.id },
        });
        if (error) throw error;
      }
      const { error } = await supabase
        .from("submissions")
        .delete()
        .eq("id", submission.id);
      if (error) throw error;
      await this.loadPublished();
      this.editingId = "";
      notify("Recuerdo eliminado.");
    } catch {
      notify("No pudimos eliminar este recuerdo.", "error");
    } finally {
      this.busy = false;
    }
  },
  async migratePublished() {
    if (!supabase) return;
    const targets = this.published
      .flatMap((submission) => submission.media)
      .filter((item) => !item.r2_path);
    if (!targets.length) return notify("Todo lo publicado ya está en R2.");
    this.busy = true;
    let migrated = 0;
    try {
      for (const item of targets) {
        const { error } = await supabase.functions.invoke("manage-media", {
          body: { action: "migrate", mediaId: item.id },
        });
        if (error) throw error;
        migrated += 1;
      }
      await this.loadPublished();
      notify(
        `${migrated} ${migrated === 1 ? "archivo migrado" : "archivos migrados"} a R2.`,
      );
    } catch {
      notify(
        `Se migraron ${migrated} archivos. Reintenta para continuar.`,
        "error",
      );
    } finally {
      this.busy = false;
    }
  },
  async signOut() {
    if (supabase) await supabase.auth.signOut();
    this.state = "guest";
    this.submissions = [];
    this.published = [];
    this.editingId = "";
    this.message = "";
  },
  fail(message: string) {
    this.state = "guest";
    this.isError = true;
    this.message = message;
    notify(message, "error");
  },
  stopStarting(message: string) {
    this.starting = false;
    this.busy = false;
    this.fail(message);
  },
}));
