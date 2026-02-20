// scrape.mjs
import fs from "fs";
import path from "path";
import { chromium } from "playwright";

const SOURCE_URL =
  "https://intermountainhealthcare.org/locations/st-george-regional-hospital";

const OUT_DIR = "docs";          // GitHub Pages publishes from /docs
const OUT_FILE = "st-george.json";
const MAX_ITEMS = 8;

function absUrl(href) {
  if (!href) return "";
  if (href.startsWith("http://") || href.startsWith("https://")) return href;
  // handle protocol-relative //example.com/img.jpg
  if (href.startsWith("//")) return `https:${href}`;
  // site-relative
  if (href.startsWith("/")) return `https://intermountainhealthcare.org${href}`;
  return href;
}

function cleanText(s) {
  return String(s || "").replace(/\s+/g, " ").trim();
}

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage({
    // optional: more “real browser” feel
    userAgent:
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122 Safari/537.36",
  });

  // Don't use networkidle; this site can keep background requests alive.
  await page.goto(SOURCE_URL, { waitUntil: "domcontentloaded", timeout: 120000 });

  // Give client-side rendering time to hydrate + lazy-load
  await page.waitForTimeout(4500);

  // Ensure the section exists before evaluating
  await page.waitForSelector("text=You might be interested in", { timeout: 60000 });

  // Scroll a bit to encourage lazy images to resolve src/srcset/currentSrc
  await page.evaluate(() => window.scrollBy(0, 900));
  await page.waitForTimeout(1500);

  const items = await page.evaluate((MAX) => {
    const norm = (s) => String(s || "").replace(/\s+/g, " ").trim();

    // Find the section by heading text (case-insensitive)
    const heading = Array.from(document.querySelectorAll("h1,h2,h3"))
      .find(el => norm(el.textContent).toLowerCase().includes("you might be interested in"));

    if (!heading) return [];

    // Climb to a container that includes multiple cards/links
    let root = heading.parentElement;
    for (let i = 0; i < 10 && root; i++) {
      const linkedHeadingsCount = root.querySelectorAll("a[href] h2, a[href] h3").length;
      const anyLinks = root.querySelectorAll("a[href]").length;
      if (linkedHeadingsCount >= MAX || anyLinks >= 12) break;
      root = root.parentElement;
    }
    if (!root) return [];

    // Gather candidate anchors that contain a heading (title)
    const candidates = Array.from(root.querySelectorAll("a[href]"))
      .map(a => {
        const h = a.querySelector("h2,h3") || a.closest("h2,h3");
        if (!h) return null;
        return { a, h };
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
      if (!title) continue;

      const href = a.getAttribute("href") || "";

      // Card container: try common wrappers
      const card =
        a.closest("article") ||
        a.closest("li") ||
        a.closest("[class*='card']") ||
        a.closest("div") ||
        a.parentElement;

      // Robust image extraction:
      // - <picture><img srcset ...> uses currentSrc
      // - lazy loads may use data-src
      // - sometimes background-image
      let imageUrl = "";

      // 1) Try image inside the card
      const img = card?.querySelector("img");
      if (img) {
        imageUrl =
          img.currentSrc ||
          img.src ||
          img.getAttribute("src") ||
          img.getAttribute("data-src") ||
          img.getAttribute("data-lazy-src") ||
          "";
      }

      // 2) Try source/srcset from <source> in <picture>
      if (!imageUrl) {
        const source = card?.querySelector("picture source[srcset], source[srcset]");
        const srcset = source?.getAttribute("srcset") || "";
        if (srcset) {
          // srcset format: "url 320w, url 640w, ..."
          const first = srcset.split(",")[0]?.trim().split(" ")[0];
          if (first) imageUrl = first;
        }
      }

      // 3) Try background-image style
      if (!imageUrl) {
        const bgEl = card?.querySelector("[style*='background-image']") || null;
        const bg = bgEl ? window.getComputedStyle(bgEl).backgroundImage : "";
        const m = bg && bg.match(/url\(["']?(.*?)["']?\)/);
        if (m && m[1]) imageUrl = m[1];
      }

      // Category + description heuristics:
      // Pull text blocks and choose likely candidates by length
      const textBits = Array.from(card?.querySelectorAll("p, span, div") || [])
        .map(el => norm(el.textContent))
        .filter(Boolean)
        .filter(t => t !== title);

      // Category tends to be short label-ish
      const category = textBits.find(t => t.length >= 3 && t.length <= 45) || "";

      // Description tends to be a sentence+ (longer)
      const description = textBits.find(t => t.length >= 60) || "";

      results.push({ title, url: href, category, description, imageUrl });
    }

    return results;
  }, MAX_ITEMS);

  await browser.close();

  // Normalize URLs to absolute, clean text
  const normalized = items.slice(0, MAX_ITEMS).map((it) => ({
    title: cleanText(it.title),
    url: absUrl(it.url),
    category: cleanText(it.category),
    description: cleanText(it.description),
    imageUrl: absUrl(it.imageUrl),
  }));

  const payload = {
    sourceUrl: SOURCE_URL,
    scrapedAt: new Date().toISOString(), // remove this if you only want commits when items truly change
    items: normalized,
  };

  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(path.join(OUT_DIR, OUT_FILE), JSON.stringify(payload, null, 2), "utf8");

  console.log(`Wrote ${normalized.length} items to ${OUT_DIR}/${OUT_FILE}`);
})();
