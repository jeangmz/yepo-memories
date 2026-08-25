import Alpine from "alpinejs";
import { supabase } from "../lib/supabase";

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

Alpine.data("management", () => ({
  state: "checking" as "checking" | "guest" | "admin",
  email: "",
  password: "",
  busy: false,
  starting: false,
  message: "",
  isError: false,
  userId: "",
  submissions: [] as PendingSubmission[],
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
    await this.loadSubmissions();
  },
  async loadSubmissions() {
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
      await this.loadSubmissions();
      this.message =
        status === "approved"
          ? "Recuerdo publicado."
          : "Recuerdo rechazado y eliminado.";
      this.isError = false;
    } catch {
      this.fail("No pudimos completar la revisión. Inténtalo de nuevo.");
    } finally {
      this.busy = false;
    }
  },
  async publish(item: PendingMedia, submissionId: string) {
    if (!supabase) return;
    const { data: file, error: downloadError } = await supabase.storage
      .from(item.pending_bucket)
      .download(item.pending_path);
    if (downloadError || !file)
      throw downloadError ?? new Error("Archivo no disponible.");
    const bucket = item.kind === "image" ? "gallery-images" : "gallery-videos";
    const extension = item.kind === "image" ? "webp" : "mp4";
    const path = `approved/${submissionId}/${item.id}.${extension}`;
    const { error: uploadError } = await supabase.storage
      .from(bucket)
      .upload(path, file, {
        contentType: item.mime_type,
        upsert: false,
      });
    if (uploadError) throw uploadError;
    const { error: mediaError } = await supabase
      .from("media")
      .update({ published_bucket: bucket, published_path: path })
      .eq("id", item.id);
    if (mediaError) throw mediaError;
  },
  async signOut() {
    if (supabase) await supabase.auth.signOut();
    this.state = "guest";
    this.submissions = [];
    this.message = "";
  },
  fail(message: string) {
    this.state = "guest";
    this.isError = true;
    this.message = message;
  },
  stopStarting(message: string) {
    this.starting = false;
    this.busy = false;
    this.fail(message);
  },
}));
