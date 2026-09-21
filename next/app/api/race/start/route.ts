import { readStart, releaseStart } from "@/lib/race-start";

export const runtime = "nodejs";
export const maxDuration = 60;

export async function POST(request: Request) {
  const body = await request.json().catch(() => null);
  let ticket;
  try { ticket = readStart(body?.token); }
  catch (error) { return Response.json({ error: (error as Error).message }, { status: 400 }); }
  try {
    await releaseStart(ticket);
    return Response.json({ started: true });
  } catch {
    return Response.json({ error: "Could not start the prepared race. Retry, or prepare the browsers again." }, { status: 409 });
  }
}
