import { completePasswordReset } from "@/src/auth/recovery";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  try {
    const body = (await req.json()) as {
      token?: string;
      newPassword?: string;
      confirmPassword?: string;
    };
    const result = await completePasswordReset({
      token: body.token ?? "",
      newPassword: body.newPassword ?? "",
      confirmPassword: body.confirmPassword ?? "",
    });
    return Response.json({
      ok: true,
      userId: result.userId,
      note: "Password updated. Previous sessions were revoked. Sign in again.",
    });
  } catch (err) {
    return Response.json(
      { error: err instanceof Error ? err.message : "reset failed" },
      { status: 400 },
    );
  }
}
