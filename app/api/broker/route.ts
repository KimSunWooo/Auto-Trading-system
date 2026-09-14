import { getBrokerPublicStatus } from "@/src/brokers/kis-config";

export const dynamic = "force-dynamic";

export async function GET() {
  return Response.json(getBrokerPublicStatus());
}
