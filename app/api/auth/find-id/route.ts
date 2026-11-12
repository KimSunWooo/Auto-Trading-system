import { requestFindLoginId } from "@/src/auth/recovery";
import { createHash } from "node:crypto";

export const dynamic = "force-dynamic";

function requestFingerprint(req: Request): string {
  const fwd = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? "";
  const ua = req.headers.get("user-agent") ?? "";
  return createHash("sha256").update(`${fwd}|${ua}`).digest("hex").slice(0, 32);
}

export async function POST(req: Request) {
  const body = (await req.json().catch(() => ({}))) as { email?: string };
  const result = await requestFindLoginId({
    email: body.email ?? "",
    requestFingerprint: requestFingerprint(req),
  });
  return Response.json(result);
}
