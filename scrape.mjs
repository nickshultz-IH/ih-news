import fs from "fs";
import path from "path";
import { chromium } from "playwright";

const SOURCE_URL =
  "https://intermountainhealthcare.org/locations/st-george-regional-hospital";

const OUT_DIR = "docs";          // GitHub Pages will serve from /docs
const OUT_FILE = "st-george.json";

function absUrl(href) {
  if (!href) return "";
  if (href.startsWith("http")) return href;
  return `https://intermountainhealthcare.org${href}`;
}

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage();
  await page.goto(SOURCE_URL, { waitUntil: "domcontentloaded", timeout: 90000 });
await page.waitForTimeout(2500); // let the client-side render finish

  const items = await page.evaluate(() => {
    const heading = Array.from(document.querySelectorAll("h2,h3"))
      .find(el => el.textContent?.trim() === "You might be interested in");
    if (!heading) return [];

    let root = heading.parentElement;
    for (let i = 0; i < 8 && root; i++) {
      if (root.querySelectorAll("a[href]").length >= 12) break;
      root = root.parentElement;
    }
    if (!root) return [];

    // Find cards via linked headings
    const linked = Array.from(root.querySelectorAll("a[href]"))
      .map(a => {
        const h = a.querySelector("h2,h3") || a.closest("h2,h3");
        return h ? { a, h } : null;
      })
      .filter(Boolean);

    const seen = new Set();
    const results = [];

    for (const { a, h } of linked) {
      if (results.length >= 8) break;

      const href = a.getAttribute("href") || "";
      if (!href || seen.has(href)) continue;
      seen.add(href);

      const title = h.textContent?.trim() || "";
      if (!title) continue;

      const card = a.closest("article, li, div") || a.parentElement;

      const img = card?.querySelector("img");
      const imageUrl = img?.getAttribute("src") || "";

      const bits = Array.from(card?.querySelectorAll("p, span, div") || [])
        .map(el => el.textContent?.trim())
        .filter(Boolean)
        .filter(t => t !== title);

      const category = bits.find(t => t.length > 2 && t.length < 45) || "";
      const description = bits.find(t => t.length >= 60) || "";

      results.push({ title, url: href, category, description, imageUrl });
    }

    return results;
  });

  await browser.close();

  const payload = {
    sourceUrl: SOURCE_URL,
    scrapedAt: new Date().toISOString(),
    items: items.map(it => ({
      ...it,
      url: absUrl(it.url)
    }))
  };

  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(path.join(OUT_DIR, OUT_FILE), JSON.stringify(payload, null, 2), "utf8");
  console.log(`Wrote ${payload.items.length} items to ${OUT_DIR}/${OUT_FILE}`);
})();
