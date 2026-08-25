import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const maxImageBytes = 3 * 1024 ** 2;
const maxVideoBytes = 30 * 1024 ** 2;
const maxTotalBytes = 60 * 1024 ** 2;

type FileInput = { kind: "image" | "video"; mimeType: string; size: number };

const json = (body: Record<string, unknown>, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });

Deno.serve(async (request) => {
  if (request.method === "OPTIONS")
    return new Response(null, { headers: corsHeaders });
  if (request.method !== "POST")
    return json({ error: "Método no permitido." }, 405);

  try {
    const { turnstileToken, senderName, message, files } = await request.json();
    if (typeof turnstileToken !== "string" || turnstileToken.length > 2048)
      return json({ error: "Completa la verificación de seguridad." }, 400);
    if (typeof senderName !== "string" && senderName !== null)
      return json({ error: "Nombre inválido." }, 400);
    if (typeof message !== "string" && message !== null)
      return json({ error: "Mensaje inválido." }, 400);
    if ((senderName?.length ?? 0) > 60 || (message?.length ?? 0) > 300)
      return json({ error: "El contenido supera el límite permitido." }, 400);
    if (!Array.isArray(files) || files.length < 1 || files.length > 5)
      return json({ error: "Puedes enviar entre 1 y 5 archivos." }, 400);

    const validFiles = files as FileInput[];
    const valid = validFiles.every(
      (file) =>
        file &&
        typeof file.size === "number" &&
        file.size > 0 &&
        ((file.kind === "image" &&
          file.mimeType === "image/webp" &&
          file.size <= maxImageBytes) ||
          (file.kind === "video" &&
            file.mimeType === "video/mp4" &&
            file.size <= maxVideoBytes)),
    );
    if (
      !valid ||
      validFiles.reduce((total, file) => total + file.size, 0) > maxTotalBytes
    )
      return json(
        { error: "Los archivos no cumplen los límites permitidos." },
        400,
      );

    const verification = await fetch(
      "https://challenges.cloudflare.com/turnstile/v0/siteverify",
      {
        method: "POST",
        body: new URLSearchParams({
          secret: Deno.env.get("TURNSTILE_SECRET_KEY") ?? "",
          response: turnstileToken,
        }),
      },
    ).then((response) => response.json());
    if (!verification.success || verification.action !== "share_memory")
      return json(
        { error: "La verificación expiró. Inténtalo otra vez." },
        400,
      );

    const admin = createClient(
      Deno.env.get("SUPABASE_URL") ?? "",
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "",
    );
    const submissionId = crypto.randomUUID();
    const { error: submissionError } = await admin.from("submissions").insert({
      id: submissionId,
      sender_name: senderName?.trim() || null,
      message: message?.trim() || null,
    });
    if (submissionError) throw submissionError;

    const media = validFiles.map((file) => {
      const bucket =
        file.kind === "image" ? "pending-images" : "pending-videos";
      const path = `pending/${submissionId}/${crypto.randomUUID()}.${file.kind === "image" ? "webp" : "mp4"}`;
      return { bucket, path, file };
    });
    const { error: mediaError } = await admin.from("media").insert(
      media.map(({ bucket, path, file }) => ({
        submission_id: submissionId,
        kind: file.kind,
        pending_bucket: bucket,
        pending_path: path,
        mime_type: file.mimeType,
        file_size: file.size,
      })),
    );
    if (mediaError) throw mediaError;

    const uploads = await Promise.all(
      media.map(async ({ bucket, path }) => {
        const { data, error } = await admin.storage
          .from(bucket)
          .createSignedUploadUrl(path);
        if (error || !data)
          throw error ?? new Error("No se pudo autorizar el archivo.");
        return { bucket, path, token: data.token };
      }),
    );
    return json({ uploads });
  } catch (error) {
    console.error(error);
    return json({ error: "No pudimos preparar el envío." }, 500);
  }
});
