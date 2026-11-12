import { publicMailDeliveryMode } from "@/src/auth/mailer";

export const dynamic = "force-dynamic";

/** Non-secret mail transport status for the login recovery UI. */
export async function GET() {
  const delivery = publicMailDeliveryMode();
  return Response.json({
    delivery,
    smtpConfigured: delivery === "smtp",
  });
}
