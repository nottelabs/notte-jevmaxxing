import { timingSafeEqual } from "node:crypto";
import { after } from "next/server";
import { runRace } from "@/lib/race";
import { raceViewport } from "@/lib/race-types";
import { raceModels } from "@/lib/race-model";
import { articleUrl } from "@/lib/wiki";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

export function GET() {
  return Response.json({ password_required: Boolean(process.env.RUN_PASSWORD), models: raceModels(), configured: ["NOTTE_API_KEY", "TYPESAFE_API_KEY", "CEREBRAS_API_KEY"].every((key) => Boolean(process.env[key])) });
}

export async function POST(request: Request) {
  const body = await request.json().catch(() => null);
  if (!body || typeof body !== "object") return Response.json({ error: "Enter a start and target article." }, { status: 400 });
  if (process.env.RUN_PASSWORD) {
    const expected = Buffer.from(process.env.RUN_PASSWORD);
    const given = Buffer.from(typeof body.password === "string" ? body.password : "");
    if (given.length !== expected.length || !timingSafeEqual(given, expected)) return Response.json({ error: "Incorrect race password." }, { status: 401 });
  }
  let start: string, target: string;
  try {
    start = articleUrl(body.start);
    target = articleUrl(body.target);
    if (start === target) throw new Error("Start and target must be different articles.");
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "Invalid articles." }, { status: 400 });
  }
  if (!["NOTTE_API_KEY", "TYPESAFE_API_KEY", "CEREBRAS_API_KEY"].every((key) => process.env[key])) return Response.json({ error: "The race needs Notte, TypeSafe, and Cerebras API keys configured on the server." }, { status: 503 });

  const stop = new AbortController();
  const signal = AbortSignal.any([request.signal, stop.signal]);
  const timeout = setTimeout(() => stop.abort(), 285_000);
  const encoder = new TextEncoder();
  let work: Promise<void>;
  const stream = new ReadableStream({
    start(controller) {
      const emit = (event: unknown) => { if (!signal.aborted) controller.enqueue(encoder.encode(JSON.stringify(event) + "\n")); };
      work = runRace(start, target, signal, emit, undefined, body.manual_start === true, raceViewport(body.viewport_height)).catch((error) => {
        emit({ type: "error", error: error instanceof Error ? error.message : "Race failed. Try again." });
      }).finally(() => {
        clearTimeout(timeout);
        try { controller.close(); } catch { /* Client disconnected. */ }
      });
      // Keep cleanup alive if the user cancels the streaming response.
      after(() => work);
    },
    cancel() { stop.abort(); },
  });
  return new Response(stream, { headers: { "Content-Type": "application/x-ndjson; charset=utf-8", "Cache-Control": "no-store", "X-Accel-Buffering": "no" } });
}
