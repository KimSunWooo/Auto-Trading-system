export const dynamic = "force-dynamic";

/** Process alive — no broker or RDS probes. */
export async function GET() {
  return Response.json({
    status: "ok",
    live: true,
    ts: new Date().toISOString(),
  });
}
