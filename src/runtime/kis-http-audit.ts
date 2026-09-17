import { KIS_HOSTS } from "@/src/brokers/kis-config";

export type KisHttpAudit = {
  realRequests: number;
  overseasOrders: number;
  paperRequests: number;
};

const audit: KisHttpAudit = {
  realRequests: 0,
  overseasOrders: 0,
  paperRequests: 0,
};

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return "";
  }
}

function pathOf(url: string): string {
  try {
    return new URL(url).pathname;
  } catch {
    return url;
  }
}

/** Count KIS HTTP without logging credentials, tokens, or bodies. */
export function noteKisHttp(url: string, method = "GET"): void {
  const host = hostOf(url);
  const path = pathOf(url);
  if (host.includes(new URL(KIS_HOSTS.real).host)) {
    audit.realRequests += 1;
  }
  if (host.includes(new URL(KIS_HOSTS.paper).host)) {
    audit.paperRequests += 1;
  }
  if (
    method.toUpperCase() === "POST" &&
    path.includes("/uapi/overseas-stock/v1/trading/order")
  ) {
    audit.overseasOrders += 1;
  }
}

export function kisHttpAudit(): KisHttpAudit {
  return { ...audit };
}

export function resetKisHttpAuditForTest(): void {
  audit.realRequests = 0;
  audit.overseasOrders = 0;
  audit.paperRequests = 0;
}
