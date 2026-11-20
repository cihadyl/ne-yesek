// yemek.com'dan rastgele tarif seçen serverless fonksiyon (Vercel, Node 18+)
const zlib = require("zlib");

const SITE = "https://yemek.com";
const CACHE_MS = 6 * 60 * 60 * 1000; // sitemap 6 saat önbellekte kalır
const MAX_DENEME = 6; // tarif olmayan sayfa denk gelirse yeniden dene
const HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
  "Accept-Language": "tr-TR,tr;q=0.9,en;q=0.5",
  Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
};

let cache = { cocuklar: null, urls: {}, at: 0 };

async function getText(url) {
  const r = await fetch(url, { headers: HEADERS, signal: AbortSignal.timeout(6000) });
  if (!r.ok) throw new Error(`${url} adresi ${r.status} döndürdü`);
  let buf = Buffer.from(await r.arrayBuffer());
  if (buf[0] === 0x1f && buf[1] === 0x8b) buf = zlib.gunzipSync(buf); // .xml.gz
  return buf.toString("utf8");
}

function locs(xml) {
  return [...xml.matchAll(/<loc>\s*(?:<!\[CDATA\[)?\s*([^<\]\s]+)\s*(?:\]\]>)?\s*<\/loc>/g)].map((m) => m[1]);
}

async function sitemapKokleri() {
  try {
    const robots = await getText(`${SITE}/robots.txt`);
    const bulunan = [...robots.matchAll(/^\s*sitemap:\s*(\S+)/gim)].map((m) => m[1]);
    if (bulunan.length) return bulunan;
  } catch (_) {}
  return [`${SITE}/sitemap.xml`];
}

// Soğuk başlangıçta tüm sitemap'leri değil, sadece rastgele seçilen birini indirir
async function tarifAdresleri() {
  if (!cache.cocuklar || Date.now() - cache.at > CACHE_MS) {
    const cocuklar = [];
    const urls = {};
    for (const kok of await sitemapKokleri()) {
      let xml;
      try { xml = await getText(kok); } catch (_) { continue; }
      const adresler = locs(xml);
      if (xml.includes("<sitemapindex")) {
        const tarifli = adresler.filter((u) => /tarif|recipe/i.test(u));
        cocuklar.push(...(tarifli.length ? tarifli : adresler));
      } else {
        urls[kok] = adresler;
        cocuklar.push(kok);
      }
    }
    if (cocuklar.length) cache = { cocuklar, urls, at: Date.now() };
    else if (!cache.cocuklar) throw new Error("Sitemap bulunamadı");
  }
  const secilen = cache.cocuklar[Math.floor(Math.random() * cache.cocuklar.length)];
  if (!cache.urls[secilen]) cache.urls[secilen] = locs(await getText(secilen));
  const hepsi = cache.urls[secilen];
  const tarifler = hepsi.filter((u) => /yemek\.com\/tarif\//.test(u));
  return tarifler.length ? tarifler : hepsi;
}

const ENTITY = { amp: "&", quot: '"', apos: "'", lt: "<", gt: ">", nbsp: " " };
function temizle(s) {
  if (!s) return "";
  return String(s)
    .replace(/<[^>]*>/g, " ")
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(+d))
    .replace(/&([a-z]+);/gi, (m, n) => ENTITY[n.toLowerCase()] ?? m)
    .replace(/\s+/g, " ")
    .trim();
}

function kisalt(s, n = 280) {
  if (s.length <= n) return s;
  const kes = s.slice(0, n);
  return kes.slice(0, Math.max(kes.lastIndexOf(" "), 0) || n).trim() + "…";
}

function recipeBul(dugum) {
  if (!dugum) return null;
  if (Array.isArray(dugum)) {
    for (const d of dugum) { const r = recipeBul(d); if (r) return r; }
    return null;
  }
  if (typeof dugum !== "object") return null;
  const tip = [].concat(dugum["@type"] || []);
  if (tip.includes("Recipe")) return dugum;
  return recipeBul(dugum["@graph"]);
}

function resimBul(img) {
  if (!img) return null;
  if (typeof img === "string") return img;
  if (Array.isArray(img)) return resimBul(img[0]);
  return img.url || null;
}

function meta(html, ad) {
  const m =
    html.match(new RegExp(`<meta[^>]+(?:property|name)=["']${ad}["'][^>]+content=["']([^"']*)["']`, "i")) ||
    html.match(new RegExp(`<meta[^>]+content=["']([^"']*)["'][^>]+(?:property|name)=["']${ad}["']`, "i"));
  return m ? temizle(m[1]) : "";
}

function tarifCikar(html, url, sadeceRecipe = false) {
  const bloklar = [...html.matchAll(/<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)];
  for (const b of bloklar) {
    try {
      const r = recipeBul(JSON.parse(b[1]));
      if (r && r.name) {
        return {
          baslik: temizle(r.name),
          ozet: kisalt(temizle(r.description) || meta(html, "og:description")),
          resim: resimBul(r.image) || meta(html, "og:image") || null,
          url,
        };
      }
    } catch (_) {}
  }
  // Yapılandırılmış veri yoksa sayfa başlığına ve açıklamasına düş
  if (!sadeceRecipe && /\/tarif\//.test(url)) {
    const baslik = meta(html, "og:title");
    if (baslik) {
      return {
        baslik,
        ozet: kisalt(meta(html, "og:description")),
        resim: meta(html, "og:image") || null,
        url,
      };
    }
  }
  return null;
}

// ---- Çorba: yemek.com/tarif/corba/ kategorisinden rastgele ----
const CORBA = `${SITE}/tarif/corba/`;
let corbaCache = { sayfaSayisi: 0, nav: null, at: 0 };

function tarifLinkleri(html) {
  const set = new Set();
  for (const m of html.matchAll(/href=["'](?:https?:\/\/(?:www\.)?yemek\.com)?(\/tarif\/[a-z0-9-]+)\/?["']/gi)) {
    set.add(SITE + m[1] + "/");
  }
  return set;
}

async function corbaHazirla() {
  if (corbaCache.nav && Date.now() - corbaCache.at < CACHE_MS) return corbaCache;
  const [s1, s2] = await Promise.all([getText(CORBA), getText(`${CORBA}sayfa/2/`)]);
  const l1 = tarifLinkleri(s1);
  const l2 = tarifLinkleri(s2);
  // Her iki sayfada da geçen bağlantılar menü, kategori ve alt bilgi bağlantılarıdır; tarif değildir
  const nav = new Set([...l1].filter((u) => l2.has(u)));
  const sayfalar = [...s1.matchAll(/\/sayfa\/(\d+)\//g)].map((m) => +m[1]);
  corbaCache = { sayfaSayisi: Math.max(2, ...sayfalar), nav, at: Date.now() };
  return corbaCache;
}

async function rastgeleCorba() {
  const { sayfaSayisi, nav } = await corbaHazirla();
  for (let i = 0; i < MAX_DENEME; i++) {
    const sayfa = 1 + Math.floor(Math.random() * sayfaSayisi);
    try {
      const html = await getText(sayfa === 1 ? CORBA : `${CORBA}sayfa/${sayfa}/`);
      const adaylar = [...tarifLinkleri(html)].filter((u) => !nav.has(u));
      if (!adaylar.length) continue;
      const url = adaylar[Math.floor(Math.random() * adaylar.length)];
      const tarif = tarifCikar(await getText(url), url, true);
      if (tarif) return tarif;
    } catch (_) {}
  }
  return null;
}

module.exports = async (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  try {
    if (req.query && req.query.tur === "corba") {
      const corba = await rastgeleCorba();
      if (corba) return res.status(200).json(corba);
      return res.status(502).json({ hata: "Uygun bir çorba bulunamadı, tekrar dene." });
    }
    const basla = Date.now();
    for (let i = 0; i < MAX_DENEME && Date.now() - basla < 22000; i++) {
      const adresler = await tarifAdresleri();
      const url = adresler[Math.floor(Math.random() * adresler.length)];
      try {
        const tarif = tarifCikar(await getText(url), url);
        if (tarif) return res.status(200).json(tarif);
      } catch (_) {}
    }
    res.status(502).json({ hata: "Uygun bir tarif bulunamadı, tekrar dene." });
  } catch (e) {
    res.status(502).json({ hata: "yemek.com'a ulaşılamadı.", detay: String(e.message || e) });
  }
};
