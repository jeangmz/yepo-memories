import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { AwsClient } from "npm:aws4fetch@1.0.20";
import { createClient } from "jsr:@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const json = (body: Record<string, unknown>, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });

const objectPath = (path: string) =>
  path.split("/").map(encodeURIComponent).join("/");

Deno.serve(async (request) => {
  if (request.method === "OPTIONS")
    return new Response(null, { headers: corsHeaders });
  if (request.method !== "POST")
    return json({ error: "Método no permitido." }, 405);

  try {
    const token = request.headers.get("Authorization")?.replace("Bearer ", "");
    if (!token) return json({ error: "Sesión requerida." }, 401);

    const admin = createClient(
      Deno.env.get("SUPABASE_URL") ?? "",
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "",
    );
    const { data: auth, error: authError } = await admin.auth.getUser(token);
    if (authError || !auth.user)
      return json({ error: "Sesión inválida." }, 401);
    const { data: administrator } = await admin
      .from("admin_users")
      .select("user_id")
      .eq("user_id", auth.user.id)
      .maybeSingle();
    if (!administrator) return json({ error: "Acceso denegado." }, 403);

    const { action, mediaId } = await request.json();
    if (
      !["publish", "migrate", "delete"].includes(action) ||
      typeof mediaId !== "string"
    )
      return json({ error: "Solicitud inválida." }, 400);

    const { data: media, error: mediaError } = await admin
      .from("media")
      .select("*")
      .eq("id", mediaId)
      .maybeSingle();
    if (mediaError || !media)
      return json({ error: "Archivo no encontrado." }, 404);

    const { data: submission } = await admin
      .from("submissions")
      .select("id, status")
      .eq("id", media.submission_id)
      .maybeSingle();
    if (!submission) return json({ error: "Recuerdo no encontrado." }, 404);
    if (action === "publish" && submission.status !== "pending")
      return json({ error: "El recuerdo ya no está pendiente." }, 409);
    if (action === "migrate" && submission.status !== "approved")
      return json({ error: "El recuerdo no está publicado." }, 409);

    const endpoint = (Deno.env.get("R2_ENDPOINT") ?? "").replace(/\/$/, "");
    const bucket = Deno.env.get("R2_BUCKET") ?? "";
    if (!endpoint || !bucket) throw new Error("R2 no está configurado.");
    const r2 = new AwsClient({
      accessKeyId: Deno.env.get("R2_ACCESS_KEY_ID") ?? "",
      secretAccessKey: Deno.env.get("R2_SECRET_ACCESS_KEY") ?? "",
      service: "s3",
      region: "auto",
    });
    const r2Url = (path: string) => `${endpoint}/${bucket}/${objectPath(path)}`;
    const extension = media.kind === "image" ? "webp" : "mp4";
    const targetPath =
      media.r2_path ??
      `approved/${media.submission_id}/${media.id}.${extension}`;

    if (action === "delete") {
      await Promise.all(
        [media.r2_path, media.r2_poster_path]
          .filter(Boolean)
          .map(async (path) => {
            const response = await r2.fetch(r2Url(path!), { method: "DELETE" });
            if (!response.ok && response.status !== 404)
              throw new Error("No pudimos eliminar el archivo de R2.");
          }),
      );
      return json({ ok: true });
    }

    const sourceBucket =
      action === "publish" ? media.pending_bucket : media.published_bucket;
    const sourcePath =
      action === "publish" ? media.pending_path : media.published_path;
    if (!sourceBucket || !sourcePath)
      return json({ error: "El archivo de origen no está disponible." }, 409);
    const { data: source, error: sourceError } = await admin.storage
      .from(sourceBucket)
      .download(sourcePath);
    if (sourceError || !source)
      throw sourceError ?? new Error("No pudimos leer el archivo de origen.");

    const upload = await r2.fetch(r2Url(targetPath), {
      method: "PUT",
      body: source,
      headers: {
        "Content-Type": media.mime_type,
        "Cache-Control": "public, max-age=31536000, immutable",
      },
    });
    if (!upload.ok) throw new Error("No pudimos guardar el archivo en R2.");

    let posterPath: string | null = null;
    if (action === "migrate" && media.poster_bucket && media.poster_path) {
      const { data: poster } = await admin.storage
        .from(media.poster_bucket)
        .download(media.poster_path);
      if (poster) {
        posterPath = `approved/${media.submission_id}/${media.id}.poster.webp`;
        const posterUpload = await r2.fetch(r2Url(posterPath), {
          method: "PUT",
          body: poster,
          headers: {
            "Content-Type": "image/webp",
            "Cache-Control": "public, max-age=31536000, immutable",
          },
        });
        if (!posterUpload.ok)
          throw new Error("No pudimos guardar la vista previa.");
      }
    }
    const { error: updateError } = await admin
      .from("media")
      .update({ r2_path: targetPath, r2_poster_path: posterPath })
      .eq("id", media.id);
    if (updateError) throw updateError;
    return json({ ok: true, path: targetPath });
  } catch (error) {
    console.error(error);
    return json({ error: "No pudimos mover el archivo a R2." }, 500);
  }
});
