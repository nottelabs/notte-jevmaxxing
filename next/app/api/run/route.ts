// One request per run. It opens the Notte session, streams every step as a line of JSON, and stops the
// session when the run ends or the client goes away. No state outlives it, so any instance can serve it.
import { timingSafeEqual } from "node:crypto";
import { after } from "next/server";
import { run, stopping } from "@/lib/agent";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

function allowed(password: unknown) {
  const expected = process.env.RUN_PASSWORD;
  if (!expected) return true;
  const given = Buffer.from(typeof password === "string" ? password : "");
  return given.length === expected.length && timingSafeEqual(given, Buffer.from(expected));
}

export async function POST(request: Request) {
  const body = await request.json().catch(() => ({}));
  if (!allowed(body.password)) return Response.json({ error: "Wrong password" }, { status: 401 });
  const goal = typeof body.goal === "string" ? body.goal.trim() : "";
  const url = typeof body.url === "string" ? body.url.trim() : "";
  if (!/^https?:\/\//.test(url)) return Response.json({ error: "Enter a full http(s) URL" }, { status: 400 });
  if (!goal || goal.length > 2000) return Response.json({ error: "Enter a task of 1–2,000 characters" }, { status: 400 });

  const stop = new AbortController();
  request.signal.addEventListener("abort", () => stop.abort());
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      const write = (event: unknown) => controller.enqueue(encoder.encode(JSON.stringify(event) + "\n"));
      try {
        for await (const event of run(url, goal, stop.signal)) write(event);
      } catch (error) {
        if (!stop.signal.aborted) write({ type: "error", error: error instanceof Error ? error.message : "Run failed" });
      } finally {
        after(() => Promise.allSettled([...stopping])); // the Notte session finishes stopping after the response
        try {
          controller.close();
        } catch {}
      }
    },
    cancel() {
      stop.abort();
    },
  });
  return new Response(stream, {
    headers: { "Content-Type": "application/x-ndjson; charset=utf-8", "Cache-Control": "no-store", "X-Accel-Buffering": "no" },
  });
}

export function GET() {
  return Response.json({ password_required: Boolean(process.env.RUN_PASSWORD) });
}
