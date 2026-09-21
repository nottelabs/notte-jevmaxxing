import { timingSafeEqual } from "node:crypto";
import { after } from "next/server";
import { raceModels } from "@/lib/race-model";
import { runMatch } from "@/lib/chess/match";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 180;
const configured = () => Boolean(process.env.TYPESAFE_API_KEY && process.env.CEREBRAS_API_KEY);
export function GET() {
  return Response.json({ configured: configured(), password_required: Boolean(process.env.RUN_PASSWORD), models: raceModels() });
}
export async function POST(request: Request) {
  const body = await request.json().catch(() => null);
  if (!body || !["jev", "cerebras"].includes(body.white)) return Response.json({ error: "Choose a provider for the white pieces." }, { status: 400 });
  if (process.env.RUN_PASSWORD) {
    const expected = Buffer.from(process.env.RUN_PASSWORD), given = Buffer.from(typeof body.password === "string" ? body.password : "");
    if (expected.length !== given.length || !timingSafeEqual(expected, given)) return Response.json({ error: "Incorrect match password." }, { status: 401 });
  }
  if (!configured()) return Response.json({ error: "Configure TypeSafe and Cerebras keys to play." }, { status: 503 });
  const stop = new AbortController();
  const signal = AbortSignal.any([request.signal, stop.signal]);
  const safety = setTimeout(() => stop.abort(), 150_000);
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    start(controller) {
      const work = runMatch(body.white, signal, (event) => {
        if (!signal.aborted) controller.enqueue(encoder.encode(JSON.stringify(event) + "\n"));
      }).finally(() => { clearTimeout(safety); try { controller.close(); } catch { /* Disconnected. */ } });
      after(() => work);
    },
    cancel() { stop.abort(); },
  });
  return new Response(stream, { headers: { "Content-Type": "application/x-ndjson; charset=utf-8", "Cache-Control": "no-store", "X-Accel-Buffering": "no" } });
}
