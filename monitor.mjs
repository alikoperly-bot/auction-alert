import fs from "node:fs";
import { chromium } from "playwright";

const AUCTION_ID = "17519117";
const AUCTION_URL = `https://www.govauctions.com/auction/${AUCTION_ID}`;
const USERNAME = "alikoperly";
const token = process.env.TELEGRAM_BOT_TOKEN;
const statePath = "state/state.json";

if (!token) throw new Error("TELEGRAM_BOT_TOKEN is missing");
fs.mkdirSync("state", { recursive: true });
let state = {};
if (fs.existsSync(statePath)) {
  try { state = JSON.parse(fs.readFileSync(statePath, "utf8")); } catch {}
}

async function telegram(method, payload = {}) {
  const response = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload)
  });
  const data = await response.json();
  if (!data.ok) throw new Error(`Telegram ${method} failed: ${data.description}`);
  return data.result;
}

if (!state.chatId) {
  const updates = await telegram("getUpdates", { limit: 100, timeout: 0 });
  const messages = updates.map(x => x.message).filter(Boolean);
  const latestPrivate = messages.reverse().find(m => m.chat?.type === "private");
  if (!latestPrivate) throw new Error("No private Telegram chat found. Send /start to the bot first.");
  state.chatId = latestPrivate.chat.id;
  await telegram("sendMessage", {
    chat_id: state.chatId,
    text: `✅ تم ربط تنبيهات مزاد ${AUCTION_ID} بنجاح. سأرسل تنبيهاً عند تغيّر المنافسين في آخر 9 مزايدات.`
  });
}

let browser;
try {
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ locale: "en-US", timezoneId: "America/Chicago" });
  await page.goto(AUCTION_URL, { waitUntil: "domcontentloaded", timeout: 60000 });
  await page.getByText("Last 9 bids", { exact: true }).waitFor({ timeout: 45000 });
  await page.waitForTimeout(7000);

  const body = await page.locator("body").innerText();
  const start = body.indexOf("Last 9 bids");
  const end = body.indexOf("Other Bidders in this Auction", start);
  if (start < 0 || end < 0) throw new Error("Last 9 bids was not readable");
  const section = body.slice(start, end);

  const bidPattern = /(?:^|\n)([^\n]+)\n(?:You\n)?(\d{1,2}:\d{2}:\d{2} [AP]M)\n(\$[\d,]+\.\d{2})/g;
  const rows = [];
  for (const match of section.matchAll(bidPattern)) {
    rows.push({ name: match[1].trim(), time: match[2], price: match[3] });
  }
  if (!rows.length) throw new Error("No bids were found in Last 9 bids");

  const competitors = [...new Set(rows.map(r => r.name).filter(n => n.toLowerCase() !== USERNAME))].sort();
  const previous = Array.isArray(state.competitors) ? state.competitors : null;
  const entered = previous ? competitors.filter(x => !previous.includes(x)) : [];
  const exited = previous ? previous.filter(x => !competitors.includes(x)) : [];
  const currentPrice = rows[0].price;

  if (previous && (entered.length || exited.length)) {
    const parts = [`🚨 تغيّر المزاودون في مزاد ${AUCTION_ID}`];
    if (entered.length) parts.push(`دخل: ${entered.join(", ")}`);
    if (exited.length) parts.push(`خرج: ${exited.join(", ")}`);
    parts.push(`النشطون الآن: ${competitors.length ? competitors.join(", ") : "لا أحد"}`);
    parts.push(`السعر الحالي: ${currentPrice}`);
    parts.push(AUCTION_URL);
    await telegram("sendMessage", { chat_id: state.chatId, text: parts.join("\n") });
  }

  state.competitors = competitors;
  state.currentPrice = currentPrice;
  state.lastChecked = new Date().toISOString();
  state.lastError = null;
} catch (error) {
  const message = String(error?.message || error);
  if (state.lastError !== message) {
    await telegram("sendMessage", {
      chat_id: state.chatId,
      text: `⚠️ تعذّر فحص مزاد ${AUCTION_ID}: ${message}`
    });
  }
  state.lastError = message;
  throw error;
} finally {
  if (browser) await browser.close();
  fs.writeFileSync(statePath, JSON.stringify(state, null, 2));
}
