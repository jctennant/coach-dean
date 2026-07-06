import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { Spectrum, text, typing, attachment } from "spectrum-ts";
import { imessage, effect, nativeContactCard } from "spectrum-ts/providers/imessage";

function requireEnv(name: string): string {
  const val = process.env[name];
  if (!val) throw new Error(`Missing required env var: ${name}`);
  return val;
}

// Initialize Spectrum SDK once on startup — holds the persistent iMessage connection.
// All send requests share this instance rather than reconnecting per-request.
console.log("[sidecar] connecting to Spectrum...");
const spectrumApp = await Spectrum({
  projectId: requireEnv("PHOTON_PROJECT_ID"),
  projectSecret: requireEnv("PHOTON_PROJECT_SECRET"),
  providers: [imessage.config()],
});
const im = imessage(spectrumApp);
console.log("[sidecar] Spectrum connected");

const app = new Hono();

// All endpoints require a shared secret so only Vercel can call this service.
app.use("*", async (c, next) => {
  const auth = c.req.header("Authorization");
  const secret = process.env.SIDECAR_SECRET;
  if (secret && auth !== `Bearer ${secret}`) {
    return c.json({ error: "Unauthorized" }, 401);
  }
  await next();
});

// POST /send — send a plain text message
// Body: { to: string, body: string }
app.post("/send", async (c) => {
  const { to, body: messageBody } = await c.req.json<{ to: string; body: string }>();
  console.log("[sidecar] send →", to, messageBody.slice(0, 60));
  const user = await im.user(to);
  const space = await im.space(user);
  await space.send(text(messageBody));
  return c.json({ ok: true });
});

// POST /send-media — send a message with an image/file attachment
// Body: { to: string, body?: string, mediaUrl: string, mimeType?: string, name?: string }
app.post("/send-media", async (c) => {
  const { to, body: messageBody, mediaUrl, mimeType, name } = await c.req.json<{
    to: string;
    body?: string;
    mediaUrl: string;
    mimeType?: string;
    name?: string;
  }>();
  console.log("[sidecar] send-media →", to, mediaUrl.slice(0, 80));
  const user = await im.user(to);
  const space = await im.space(user);
  if (messageBody) await space.send(text(messageBody));
  await space.send(
    attachment(new URL(mediaUrl), {
      mimeType: mimeType ?? "image/png",
      name: name ?? "image.png",
    })
  );
  return c.json({ ok: true });
});

// POST /typing — show typing indicator
// Body: { to: string }
app.post("/typing", async (c) => {
  const { to } = await c.req.json<{ to: string }>();
  const user = await im.user(to);
  const space = await im.space(user);
  await space.send(typing());
  return c.json({ ok: true });
});

// POST /share-contact-card — share the bot's native iMessage contact card
// Body: { to: string }
app.post("/share-contact-card", async (c) => {
  const { to } = await c.req.json<{ to: string }>();
  const user = await im.user(to);
  const space = await im.space(user);
  // nativeContactCard is iMessage-specific
  await space.send(nativeContactCard() as never);
  return c.json({ ok: true });
});

// POST /send-effect — send a message with an iMessage bubble/screen effect
// Body: { to: string, body: string, effectType: "screen"|"bubble", effectName: string }
app.post("/send-effect", async (c) => {
  const { to, body: messageBody, effectName } = await c.req.json<{
    to: string;
    body: string;
    effectType: "screen" | "bubble";
    effectName: string;
  }>();
  console.log("[sidecar] send-effect →", to, effectName);
  const user = await im.user(to);
  const space = await im.space(user);

  // Map Linq-style effect names to Spectrum's Apple identifiers
  type EffectKey = keyof typeof imessage.effect.message;
  const effectKey = effectName as EffectKey;
  const appleEffect = imessage.effect.message[effectKey];

  if (appleEffect) {
    await space.send(effect(text(messageBody), appleEffect));
  } else {
    // Unknown effect — fall back to plain text
    console.warn("[sidecar] unknown effect name:", effectName, "— falling back to plain text");
    await space.send(text(messageBody));
  }
  return c.json({ ok: true });
});

// GET /health
app.get("/health", (c) => c.json({ ok: true }));

const port = parseInt(process.env.PORT ?? "3000");
serve({ fetch: app.fetch, port });
console.log(`[sidecar] listening on port ${port}`);
