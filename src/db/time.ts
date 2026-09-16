/** MySQL DATETIME(6) UTC. UI still formats with Asia/Seoul. */
export function toMysqlUtc(input?: Date | string | number | null): string {
  const date =
    input instanceof Date
      ? input
      : typeof input === "number"
        ? new Date(input)
        : typeof input === "string" && input
          ? new Date(input.includes("T") || input.endsWith("Z") ? input : `${input.replace(" ", "T")}Z`)
          : new Date();
  if (Number.isNaN(date.getTime())) return toMysqlUtc(new Date());
  const iso = date.toISOString();
  const [day, rest] = iso.split("T");
  const time = (rest ?? "00:00:00.000Z").replace("Z", "");
  const [hms, ms = "000"] = time.split(".");
  return `${day} ${hms}.${ms.padEnd(6, "0").slice(0, 6)}`;
}

export function mysqlDateUtc(input?: Date | string | number | null): string {
  return toMysqlUtc(input).slice(0, 10);
}
