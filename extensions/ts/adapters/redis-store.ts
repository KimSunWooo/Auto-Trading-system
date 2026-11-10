/**
 * Real Redis UI quote cache.
 * applyTradeLua is atomic: dedupe SET + latest + minute bar in one EVAL.
 * Kafka offset must be committed only AFTER this returns successfully.
 */
import Redis from "ioredis";
import type { LatestQuote, MinuteBar, TradeEvent } from "../shared/types.ts";
import {
  DEDUPE_TTL_SEC,
  OHLCV_WINDOW_MINUTES,
  OHLCV_WINDOW_MS,
} from "../shared/config.ts";
import { minuteStart } from "../redis/memory-store.ts";

export type ApplyTradeResult = {
  applied: boolean;
  duplicate: boolean;
  late: boolean;
};

const APPLY_TRADE_LUA = `
-- KEYS: dedupeKey, latestKey, barKey, zsetKey, incompleteKey
-- ARGV: eventId, ttlSec, exchangeTs, receivedTs, price, volume, bid, ask, minuteStart, windowMs, incompleteFlag
local dedupeKey = KEYS[1]
local latestKey = KEYS[2]
local barKey = KEYS[3]
local zsetKey = KEYS[4]
local incompleteKey = KEYS[5]

local eventId = ARGV[1]
local ttlSec = tonumber(ARGV[2])
local exchangeTs = tonumber(ARGV[3])
local receivedTs = tonumber(ARGV[4])
local price = tonumber(ARGV[5])
local volume = tonumber(ARGV[6])
local bid = ARGV[7]
local ask = ARGV[8]
local minuteStart = tonumber(ARGV[9])
local windowMs = tonumber(ARGV[10])
local markIncomplete = ARGV[11]

if redis.call('SISMEMBER', dedupeKey, eventId) == 1 then
  return {0, 1, 0} -- applied=0, duplicate=1, late=0
end

redis.call('SADD', dedupeKey, eventId)
redis.call('EXPIRE', dedupeKey, ttlSec)

local prevEx = redis.call('HGET', latestKey, 'exchangeTsMs')
local late = 0
if prevEx then
  local prevN = tonumber(prevEx)
  if exchangeTs + 5000 < prevN then
    late = 1
  end
end

-- Latest: never move backwards on exchangeTs
if (not prevEx) or (exchangeTs >= tonumber(prevEx)) then
  redis.call('HSET', latestKey,
    'price', price,
    'exchangeTsMs', exchangeTs,
    'receivedTsMs', receivedTs,
    'eventId', eventId,
    'bid', bid,
    'ask', ask
  )
end

local open = redis.call('HGET', barKey, 'open')
local incomplete = redis.call('HGET', barKey, 'incomplete')
if markIncomplete == '1' then incomplete = '1' end
if redis.call('SISMEMBER', incompleteKey, tostring(minuteStart)) == 1 then
  incomplete = '1'
end

if not open then
  redis.call('HSET', barKey,
    'minuteStartMs', minuteStart,
    'open', price,
    'openExchangeTsMs', exchangeTs,
    'high', price,
    'low', price,
    'close', price,
    'closeExchangeTsMs', exchangeTs,
    'volume', volume,
    'tradeCount', 1,
    'incomplete', incomplete or '0',
    'updatedAtMs', receivedTs
  )
else
  local high = tonumber(redis.call('HGET', barKey, 'high'))
  local low = tonumber(redis.call('HGET', barKey, 'low'))
  if price > high then high = price end
  if price < low then low = price end
  -- Open = earliest exchangeTs; close = latest exchangeTs
  local prevOpenEx = tonumber(redis.call('HGET', barKey, 'openExchangeTsMs') or exchangeTs)
  if exchangeTs < prevOpenEx then
    redis.call('HSET', barKey, 'open', price, 'openExchangeTsMs', exchangeTs)
  end
  local prevCloseEx = tonumber(redis.call('HGET', barKey, 'closeExchangeTsMs') or '0')
  if exchangeTs >= prevCloseEx then
    redis.call('HSET', barKey, 'close', price, 'closeExchangeTsMs', exchangeTs)
  end
  redis.call('HSET', barKey,
    'high', high,
    'low', low,
    'volume', tonumber(redis.call('HGET', barKey, 'volume')) + volume,
    'tradeCount', tonumber(redis.call('HGET', barKey, 'tradeCount')) + 1,
    'incomplete', incomplete or '0',
    'updatedAtMs', math.max(tonumber(redis.call('HGET', barKey, 'updatedAtMs') or '0'), receivedTs)
  )
end

redis.call('ZADD', zsetKey, minuteStart, tostring(minuteStart))
-- Expire minutes outside 10m window
local cutoff = receivedTs - windowMs
local old = redis.call('ZRANGEBYSCORE', zsetKey, '-inf', cutoff)
for _, m in ipairs(old) do
  redis.call('ZREM', zsetKey, m)
  redis.call('DEL', 'ext:bar:' .. ARGV[12] .. ':' .. m)
  redis.call('SREM', incompleteKey, m)
end

return {1, 0, late}
`;

export class RedisQuoteStore {
  readonly adapter = "redis" as const;
  constructor(private readonly redis: Redis) {}

  /** Expose for tests that inject a failing client. */
  get client(): Redis {
    return this.redis;
  }

  static connect(url: string): RedisQuoteStore {
    const redis = new Redis(url, {
      maxRetriesPerRequest: 2,
      enableReadyCheck: true,
      lazyConnect: false,
    });
    return new RedisQuoteStore(redis);
  }

  async ping(): Promise<{ ok: boolean; detail: string }> {
    try {
      const pong = await this.redis.ping();
      return { ok: pong === "PONG", detail: pong };
    } catch (err) {
      return { ok: false, detail: err instanceof Error ? err.message : String(err) };
    }
  }

  async flushNamespace(): Promise<void> {
    const keys = await this.redis.keys("ext:*");
    if (keys.length) await this.redis.del(...keys);
  }

  async markIncomplete(symbol: string, atMs: number): Promise<void> {
    const m = minuteStart(atMs);
    await this.redis.sadd(`ext:incomplete:${symbol}`, String(m));
    const barKey = `ext:bar:${symbol}:${m}`;
    if (await this.redis.exists(barKey)) {
      await this.redis.hset(barKey, "incomplete", "1");
    }
  }

  async applyTrade(event: TradeEvent): Promise<ApplyTradeResult> {
    const m = minuteStart(event.exchangeTsMs);
    const keys = [
      `ext:dedupe:${event.symbol}`,
      `ext:latest:${event.symbol}`,
      `ext:bar:${event.symbol}:${m}`,
      `ext:zset:${event.symbol}`,
      `ext:incomplete:${event.symbol}`,
    ];
    const argv = [
      event.eventId,
      String(DEDUPE_TTL_SEC),
      String(event.exchangeTsMs),
      String(event.receivedTsMs),
      String(event.price),
      String(event.tradeVolume),
      event.bid != null ? String(event.bid) : "",
      event.ask != null ? String(event.ask) : "",
      String(m),
      String(OHLCV_WINDOW_MS),
      "0",
      event.symbol,
    ];
    const raw = (await this.redis.eval(APPLY_TRADE_LUA, keys.length, ...keys, ...argv)) as [
      number,
      number,
      number,
    ];
    return {
      applied: raw[0] === 1,
      duplicate: raw[1] === 1,
      late: raw[2] === 1,
    };
  }

  async getLatest(symbol: string): Promise<LatestQuote | null> {
    const h = await this.redis.hgetall(`ext:latest:${symbol}`);
    if (!h.price) return null;
    return {
      symbol,
      price: Number(h.price),
      bid: h.bid ? Number(h.bid) : undefined,
      ask: h.ask ? Number(h.ask) : undefined,
      exchangeTsMs: Number(h.exchangeTsMs),
      receivedTsMs: Number(h.receivedTsMs),
      eventId: h.eventId ?? "",
    };
  }

  async getBars(symbol: string): Promise<MinuteBar[]> {
    const members = await this.redis.zrange(`ext:zset:${symbol}`, 0, -1);
    const bars: MinuteBar[] = [];
    for (const m of members) {
      const h = await this.redis.hgetall(`ext:bar:${symbol}:${m}`);
      if (!h.open) continue;
      bars.push({
        minuteStartMs: Number(h.minuteStartMs ?? m),
        open: Number(h.open),
        high: Number(h.high),
        low: Number(h.low),
        close: Number(h.close),
        volume: Number(h.volume),
        tradeCount: Number(h.tradeCount),
        incomplete: h.incomplete === "1",
        updatedAtMs: Number(h.updatedAtMs ?? 0),
      });
    }
    return bars.sort((a, b) => a.minuteStartMs - b.minuteStartMs);
  }

  async close(): Promise<void> {
    await this.redis.quit().catch(() => this.redis.disconnect());
  }
}

export { OHLCV_WINDOW_MINUTES, DEDUPE_TTL_SEC };
