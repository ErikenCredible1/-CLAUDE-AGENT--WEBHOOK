const axios = require("axios");
const { Redis } = require("@upstash/redis");

function getRedis() {
  return new Redis({
    url: process.env.UPSTASH_REDIS_URL,
    token: process.env.UPSTASH_REDIS_TOKEN,
  });
}

/**
 * Check all price alerts and fire any that have triggered.
 * Called every 5 minutes by a QStash schedule.
 * @param {Function} send - function(userId, text) to send LINE messages
 */
async function checkPriceAlerts(send) {
  const redis = getRedis();
  const items = await redis.lrange("price_alerts", 0, -1);
  if (!items.length) return;

  const alerts = items.map((i) => JSON.parse(i));
  const remaining = [];

  for (const alert of alerts) {
    try {
      const price = await fetchPrice(alert.symbol, alert.type);
      if (price === null) {
        remaining.push(alert); // keep if fetch failed
        continue;
      }

      const triggered =
        (alert.condition === "above" && price >= alert.target) ||
        (alert.condition === "below" && price <= alert.target);

      if (triggered) {
        const direction = alert.condition === "above" ? "📈" : "📉";
        await send(
          alert.userId,
          `🔔 Price Alert!\n\n${direction} ${alert.symbol.toUpperCase()} is now $${price.toLocaleString()}\nYour target: ${alert.condition} $${alert.target.toLocaleString()}`
        );
        // Don't add back to remaining — alert consumed
      } else {
        remaining.push(alert);
      }
    } catch (err) {
      console.error(`Alert check error for ${alert.symbol}:`, err.message);
      remaining.push(alert);
    }
  }

  // Replace alert list with untriggered ones
  await redis.del("price_alerts");
  for (const alert of remaining) {
    await redis.rpush("price_alerts", JSON.stringify(alert));
  }
}

async function fetchPrice(symbol, type) {
  try {
    if (type === "stock") {
      const url = `https://query1.finance.yahoo.com/v8/finance/chart/${symbol.toUpperCase()}?interval=1d&range=1d`;
      const res = await axios.get(url, { headers: { "User-Agent": "Mozilla/5.0" }, timeout: 8000 });
      return res.data.chart.result[0].meta.regularMarketPrice;
    }

    if (type === "crypto") {
      const res = await axios.get(
        `https://api.coingecko.com/api/v3/simple/price?ids=${symbol}&vs_currencies=usd`,
        { timeout: 8000 }
      );
      return res.data[symbol]?.usd ?? null;
    }
  } catch {
    return null;
  }
  return null;
}

module.exports = { checkPriceAlerts };
