// scrape.mjs
import fs from "fs";
import path from "path";
import { chromium } from "playwright";

const SOURCE_URL =
  "https://intermountainhealthcare.org/locations/st-george-regional-hospital";

const OUT_DIR = "docs";
const OUT_FILE = "st-george.json";
const MAX_ITEMS = 8;

// ---------- helpers ----------
function absUrl(href) {
  if (!href) return "";
  if (href.startsWith("http://") || href.startsWith("https://")) return href;
  if (href.startsWith("//")) return `https:${href}`;
  if (href.startsWith("/")) return `https://intermountainhealthcare.org${href}`;
  return href;
}

function cleanText(s) {
  return String(s || "").replace(/\s+/g, " ").trim();
}

// Fetch OG image from the article page HTML (fast, no browser needed)
async function fetchOgImage(articleUrl, timeoutMs = 20000) {
  const url = absUrl(articleUrl);
  if (!url) return "";

  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: {
        // mimic a browser a bit
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122 Safari/537.36",
        "Accept":
          "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
      },
    });

    if (!res.ok) return "";
    const html = await res.text();

    // Try og:image first
    let m =
      html.match(/<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["'][^>]*>/i) ||
      html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:image["'][^>]*>/i);

    if (m && m[1]) return absUrl(m[1]);

    // Fallback: twitter:image
    m =
      html.match(/<meta[^>]+name=["']twitter:image["'][^>]+content=["']([^"']+)["'][^>]*>/i) ||
      html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+name=["']twitter:image["'][^>]*>/i);

    if (m && m[1]) return absUrl(m[1]);

    return "";
  } catch {
    return "";
  } finally {
    clearTimeout(t);
  }
}

// Simple concurrency limiter so we don't hammer the site
async function mapWithConcurrency(items, limit, mapper) {
  const results = new Array(items.length);
  let i = 0;

  async function worker() {
    while (true) {
      const idx = i++;
      if (idx >= items.length) return;
      results[idx] = await mapper(items[idx], idx);
    }
  }

  const workers = Array.from({ length: Math.min(limit, items.length) }, () => worker());
  await Promise.all(workers);
  return results;
}

// ---------- main ----------
(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage();

  // More reliable than networkidle
  await page.goto(SOURCE_URL, { waitUntil: "domcontentloaded", timeout: 120000 });
  await page.waitForTimeout(4500);
  await page.waitForSelector("text=You might be interested in", { timeout: 60000 });

  // Scroll a little to ensure the section is rendered
  await page.evaluate(() => window.scrollBy(0, 900));
  await page.waitForTimeout(1000);

  // Scrape the first 8 items (title/url/category/description)
  const baseItems = await page.evaluate((MAX) => {
    const norm = (s) => String(s || "").replace(/\s+/g, " ").trim();

    const heading = Array.from(document.querySelectorAll("h1,h2,h3"))
      .find(el => norm(el.textContent).toLowerCase().includes("you might be interested in"));

    if (!heading) return [];

    // Find a reasonable container around the carousel/cards
    let root = heading.parentElement;
    for (let i = 0; i < 10 && root; i++) {
      const linkedHeadings = root.querySelectorAll("a[href] h2, a[href] h3").length;
      const links = root.querySelectorAll("a[href]").length;
      if (linkedHeadings >= MAX || links >= 12) break;
      root = root.parentElement;
    }
    if (!root) return [];

    // Candidate anchors that contain a title heading
    const candidates = Array.from(root.querySelectorAll("a[href]"))
      .map(a => {
        const h = a.querySelector("h2,h3") || a.closest("h2,h3");
        return h ? { a, h } : null;
      })
      .filter(Boolean);

    // Deduplicate by href
    const seen = new Set();
    const deduped = [];
    for (const c of candidates) {
      const href = c.a.getAttribute("href") || "";
      if (!href || seen.has(href)) continue;
      seen.add(href);
      deduped.push(c);
    }

    const results = [];
    for (const { a, h } of deduped) {
      if (results.length >= MAX) break;

      const title = norm(h.textContent);
      const href = a.getAttribute("href") || "";
      if (!title || !href) continue;

      const card =
        a.closest("article") ||
        a.closest("li") ||
        a.closest("div") ||
        a.parentElement;

      const textBits = Array.from(card?.querySelectorAll("p, span, div") || [])
        .map(el => norm(el.textContent))
        .filter(Boolean)
        .filter(t => t !== title);

      const category = textBits.find(t => t.length >= 3 && t.length <= 45) || "";
      const description = textBits.find(t => t.length >= 60) || "";

      results.push({ title, url: href, category, description });
    }

    return results;
  }, MAX_ITEMS);

  await browser.close();

  // Normalize and clean
  const cleaned = baseItems.slice(0, MAX_ITEMS).map((it) => ({
    title: cleanText(it.title),
    url: absUrl(it.url),
    category: cleanText(it.category),
    description: cleanText(it.description),
    imageUrl: "", // will fill from og:image
  }));

  // Fetch og:image for each article with modest concurrency
  const withImages = await mapWithConcurrency(cleaned, 3, async (item) => {
    const img = await fetchOgImage(item.url);
    return { ...item, imageUrl: img || "" };
  });

  const payload = {
    sourceUrl: SOURCE_URL,
    scrapedAt: new Date().toISOString(),
    items: withImages,
  };

  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(path.join(OUT_DIR, OUT_FILE), JSON.stringify(payload, null, 2), "utf8");

  console.log(`Wrote ${withImages.length} items to ${OUT_DIR}/${OUT_FILE}`);
})();
