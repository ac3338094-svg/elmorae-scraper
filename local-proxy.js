const http = require('http');
const https = require('https');
const url = require('url');
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright-chromium');

const PORT = process.env.PORT || 5501;

let globalBrowser = null;
async function getBrowser() {
  if (!globalBrowser) {
    globalBrowser = await chromium.launch({ 
      headless: true, 
      args: [
        '--no-sandbox', '--disable-setuid-sandbox', '--disable-http2',
        '--disable-blink-features=AutomationControlled',
        '--disable-features=IsolateOrigins,site-per-process'
      ] 
    });
  }
  return globalBrowser;
}

// --- Concurrency Queue (prevents RAM overload) ---
let activeScrapes = 0;
const MAX_CONCURRENT = 3;
const waitQueue = [];

async function acquireSlot() {
  if (activeScrapes < MAX_CONCURRENT) { activeScrapes++; return; }
  return new Promise(resolve => waitQueue.push(resolve));
}
function releaseSlot() {
  activeScrapes--;
  if (waitQueue.length > 0) { activeScrapes++; waitQueue.shift()(); }
}

const MIME_TYPES = {
  '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css',
  '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpg',
  '.gif': 'image/gif', '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
};

// --- Smart HTTP fetch with redirect following ---
function smartFetch(targetUrl, maxRedirects = 5) {
  return new Promise((resolve, reject) => {
    if (maxRedirects <= 0) return reject(new Error('Too many redirects'));
    let fetchUrl = targetUrl;
    const lowUrl = fetchUrl.toLowerCase();
    if (lowUrl.includes('myntra') || lowUrl.includes('amazon') || lowUrl.includes('amzn')) {
      const apiKey = process.env.SCRAPERAPI_KEY || '2917b215b8a13776ec2dafa44cd165a2';
      fetchUrl = `http://api.scraperapi.com?api_key=${apiKey}&url=${encodeURIComponent(targetUrl)}`;
    }
    
    const parsed = new URL(fetchUrl);
    const client = parsed.protocol === 'https:' ? https : http;
    
    const options = {
      hostname: parsed.hostname,
      path: parsed.pathname + parsed.search,
      method: 'GET',
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9,hi;q=0.8',
        'Accept-Encoding': 'identity',
        'Cache-Control': 'no-cache',
        'Sec-Fetch-Dest': 'document',
        'Sec-Fetch-Mode': 'navigate',
        'Sec-Fetch-Site': 'none',
        'Sec-Fetch-User': '?1',
        'Upgrade-Insecure-Requests': '1',
      }
    };
    
    const req = client.get(options, (res) => {
      // Follow redirects (301, 302, 303, 307, 308)
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        const redirectUrl = res.headers.location.startsWith('http') 
          ? res.headers.location 
          : `${parsed.protocol}//${parsed.hostname}${res.headers.location}`;
        return smartFetch(redirectUrl, maxRedirects - 1).then(resolve).catch(reject);
      }
      
      let data = '';
      res.on('data', (d) => data += d);
      res.on('end', () => resolve({ data, status: res.statusCode, finalUrl: targetUrl }));
    });
    req.on('error', reject);
    req.setTimeout(15000, () => { req.destroy(); reject(new Error('Timeout')); });
  });
}

// --- Store-specific price extractors from raw HTML ---

function extractAmazonPrice(html) {
  // Method 1: JSON data embedded in page (most reliable)
  const jsonPatterns = [
    /"priceAmount"\s*:\s*(\d+\.?\d*)/,
    /"price"\s*:\s*"?(\d[\d,.]*)"?/,
    /"buyingPrice"\s*:\s*(\d[\d,.]*)/,
    /"current_price"\s*:\s*(\d[\d,.]*)/,
    /"price_value"\s*:\s*"?(\d[\d,.]*)"?/,
    /"value"\s*:\s*"?([\d,]+\.?\d*)"?\s*,\s*"currencyCode"\s*:\s*"INR"/,
  ];
  
  for (const pat of jsonPatterns) {
    const m = html.match(pat);
    if (m) {
      const val = parseFloat(m[1].replace(/,/g, ''));
      if (val > 50 && val < 500000) return val;
    }
  }

  // Method 2: Price in HTML attributes / structured data
  const structuredPatterns = [
    /class="a-price-whole"[^>]*>(\d[\d,]*)/,
    /id="priceblock_ourprice"[^>]*>[^₹]*₹\s*([\d,]+)/,
    /id="priceblock_dealprice"[^>]*>[^₹]*₹\s*([\d,]+)/,
    /apexPriceToPay[^>]*>.*?<span[^>]*>([\d,]+)/s,
    /"lowPrice"\s*:\s*"?([\d,.]+)"?/,
  ];
  
  for (const pat of structuredPatterns) {
    const m = html.match(pat);
    if (m) {
      const val = parseFloat(m[1].replace(/,/g, ''));
      if (val > 50 && val < 500000) return val;
    }
  }

  // Method 3: Regex sweep for ₹ prices
  const priceMatches = html.match(/₹\s?(\d{1,3}(?:,\d{3})*(?:\.\d{2})?)/g);
  if (priceMatches) {
    const prices = priceMatches
      .map(m => parseFloat(m.replace(/[₹,\s]/g, '')))
      .filter(n => n > 50 && n < 500000);
    if (prices.length > 0) return Math.min(...prices); // Usually the sale price is smallest
  }
  
  return null;
}

function extractFlipkartPrice(html) {
  // Method 1: JSON data
  const jsonPatterns = [
    /"selling_price"\s*:\s*\{[^}]*"amount"\s*:\s*(\d+)/,
    /"finalPrice"\s*:\s*\{[^}]*"value"\s*:\s*(\d+)/,
    /"value"\s*:\s*(\d+).*?"currencyCode"\s*:\s*"INR"/,
    /"sellingPrice"\s*:\s*(\d+)/,
    /"price"\s*:\s*(\d+)/,
  ];
  
  for (const pat of jsonPatterns) {
    const m = html.match(pat);
    if (m) {
      const val = parseFloat(m[1]);
      if (val > 50 && val < 500000) return val;
    }
  }

  // Method 2: CSS class selectors in HTML
  const classPatterns = [
    /class="[^"]*_30jeq3[^"]*"[^>]*>₹([\d,]+)/,
    /class="[^"]*_16Jk6d[^"]*"[^>]*>₹([\d,]+)/,
    /class="[^"]*Nx9bqj[^"]*"[^>]*>₹([\d,]+)/,  // Modern Flipkart class
    /class="[^"]*VU-Z7M[^"]*"[^>]*>₹([\d,]+)/,  // Added modern class
  ];
  
  for (const pat of classPatterns) {
    const m = html.match(pat);
    if (m) {
      const val = parseFloat(m[1].replace(/,/g, ''));
      if (val > 50 && val < 500000) return val;
    }
  }

  // Method 3: Generic ₹ sweep
  const priceMatches = html.match(/₹\s?(\d{1,3}(?:,\d{3})*(?:\.\d{2})?)/g);
  if (priceMatches) {
    const prices = priceMatches
      .map(m => parseFloat(m.replace(/[₹,\s]/g, '')))
      .filter(n => n > 50 && n < 500000);
    if (prices.length > 0) return Math.min(...prices);
  }
  
  return null;
}

function extractMyntraPrice(html) {
  const jsonMatch = html.match(/"discountedPrice"\s*:\s*(\d+)/) 
                 || html.match(/"price"\s*:\s*(\d+)/)
                 || html.match(/"mrp"\s*:\s*(\d+)/);
  if (jsonMatch) {
    const val = parseInt(jsonMatch[1]);
    if (val > 10 && val !== 599) return val;
  }
  return null;
}

function extractIndonesianPrice(html) {
  // 1. Target the ACTUAL Product Price IDs first (Most reliable)
  const idPatterns = [
    /id="lblPDPDetailProductPrice"[^>]*>Rp\s?([\d.,]+)/i,
    /data-testid="pdp-price"[^>]*>Rp\s?([\d.,]+)/i,
    /itemprop="price"[^>]*content="(\d+)"/i
  ];
  
  for (const pat of idPatterns) {
    const m = html.match(pat);
    if (m) {
      const val = parseFloat(m[1].replace(/[^\d]/g, ''));
      if (val > 10000) return val;
    }
  }

  // 2. Fallback: Clean HTML and find prices in the main body area
  // We skip only a small bit of the head to find prices in the main container
  const bodyStart = html.indexOf('<body');
  const mainContent = (bodyStart !== -1) ? html.substring(bodyStart + 100) : html; 
  
  const prices = [];
  const regex = /(?:Rp\.?\s?)(\d{1,3}(?:[.,]\d{3})*(?:[.,]\d{2})?)/gi;
  let match;
  
  while ((match = regex.exec(mainContent)) !== null) {
    const context = mainContent.substring(Math.max(0, match.index - 40), match.index);
    // Ignore small prices that are clearly promo conditions
    if (!/min\.|maks\.|potongan|hemat/i.test(context)) {
      const val = parseFloat(match[1].replace(/[^\d]/g, ''));
      if (val > 50000 && val < 50000000) prices.push(val);
    }
  }

  if (prices.length > 0) {
    // If we find multiple, the first one after the header is usually the main product price
    return prices[0];
  }
  
  return null;
}

function extractZaloraPrice(html) {
  // 1. MOST RELIABLE: __NEXT_DATA__ JSON (available in raw HTTP response)
  //    Zalora is a Next.js app; the raw HTML has product data in __NEXT_DATA__
  //    SpecialPrice = sale/discounted price, Price = original/MRP price
  const nextDataMatch = html.match(/__NEXT_DATA__[^>]*>(.*?)<\/script>/s);
  if (nextDataMatch) {
    try {
      const data = JSON.parse(nextDataMatch[1]);
      const product = data?.props?.pageProps?.preloadedState?.pdv?.product;
      if (product) {
        // Prefer SpecialPrice (discounted), fall back to Price (original)
        const specialPrice = parseFloat(product.SpecialPrice);
        const originalPrice = parseFloat(product.Price);
        const price = (specialPrice && specialPrice > 0) ? specialPrice : originalPrice;
        if (price > 1000 && price < 50000000) {
          console.log(`[Zalora] __NEXT_DATA__ price found: ${price} (special: ${specialPrice}, original: ${originalPrice})`);
          return price;
        }
      }
    } catch(e) {
      console.log(`[Zalora] __NEXT_DATA__ parse error: ${e.message}`);
    }
  }

  // 2. Fallback: "SpecialPrice" or "Price" as raw JSON strings in HTML
  const specialPriceMatch = html.match(/"SpecialPrice"\s*:\s*"([\d.]+)"/);
  if (specialPriceMatch) {
    const val = parseFloat(specialPriceMatch[1]);
    if (val > 1000 && val < 50000000) {
      console.log(`[Zalora] Raw SpecialPrice JSON found: ${val}`);
      return val;
    }
  }
  const rawPriceMatch = html.match(/"Price"\s*:\s*"([\d.]+)"/);
  if (rawPriceMatch) {
    const val = parseFloat(rawPriceMatch[1]);
    if (val > 1000 && val < 50000000) {
      console.log(`[Zalora] Raw Price JSON found: ${val}`);
      return val;
    }
  }

  // 3. JSON-LD structured data (rendered client-side, available in Tier 2)
  const ldMatch = html.match(/application\/ld\+json[^>]*>([^<]+)/i);
  if (ldMatch) {
    try {
      const ld = JSON.parse(ldMatch[1]);
      const price = ld.offers?.price || (ld.offers && ld.offers.price);
      if (price) {
        const val = parseFloat(String(price).replace(/[^\d.]/g, ''));
        if (val > 1000 && val < 50000000) {
          console.log(`[Zalora] JSON-LD price found: ${val}`);
          return val;
        }
      }
    } catch(e) { /* JSON parse failed, continue */ }
  }

  // 4. Zalora-specific HTML patterns: price in bold div with "text-lg font-bold" class
  //    Actual price uses &nbsp; between Rp and number: Rp&nbsp;272.000
  const zaloraPatterns = [
    /text-lg\s+font-bold"[^>]*>Rp[\s\u00a0&;nbps]*([\d.,]+)/i,
    /font-bold"[^>]*>Rp[\s\u00a0&;nbps]*([\d.,]+)/i,
  ];
  for (const pat of zaloraPatterns) {
    const m = html.match(pat);
    if (m) {
      const val = parseFloat(m[1].replace(/[^\d]/g, ''));
      if (val > 10000 && val < 50000000) {
        console.log(`[Zalora] HTML class price found: ${val}`);
        return val;
      }
    }
  }

  // 5. Fallback: Rp regex sweep, but SKIP promo/reward text
  const bodyStart = html.indexOf('<body');
  const mainContent = (bodyStart !== -1) ? html.substring(bodyStart + 100) : html;
  
  const prices = [];
  const regex = /(?:Rp\.?)[\s\u00a0&;nbps]*([\d]{1,3}(?:[.,]\d{3})*)/gi;
  let match;
  
  while ((match = regex.exec(mainContent)) !== null) {
    const context = mainContent.substring(Math.max(0, match.index - 60), match.index + match[0].length + 30);
    // Skip promo/reward/voucher/min purchase text
    if (/hadiah|Dapatkan|voucher|kupon|coupon|min\.|maks\.|potongan|hemat|cashback/i.test(context)) {
      continue;
    }
    const val = parseFloat(match[1].replace(/[^\d]/g, ''));
    if (val > 10000 && val < 50000000) prices.push(val);
  }

  if (prices.length > 0) {
    console.log(`[Zalora] Regex sweep prices: ${prices.join(', ')} — returning first`);
    return prices[0];
  }
  
  return null;
}

function extractName(html) {
  const patterns = [
    /og:title"\s*content="([^"]+)"/i,
    /<title[^>]*>(.*?)<\/title>/is,
    /id="productTitle"[^>]*>([^<]+)/i,
    /class="[^"]*B_NuCI[^"]*"[^>]*>([^<]+)/,
    /class="[^"]*VU-Z7M[^"]*"[^>]*>([^<]+)/,
  ];
  for (const pat of patterns) {
    const m = html.match(pat);
    if (m && m[1].trim().length > 3) {
      let n = m[1].split('|')[0].replace(/ - Buy.*/, '').replace(/: Amazon\.in.*/, '').replace(/ at best price.*$/i, '').trim();
      return n.substring(0, 150);
    }
  }
  return null;
}

function extractImage(html) {
  const patterns = [
    // Amazon mobile: product-image class (full-size URL directly)
    /class="[^"]*product-image[^"]*"[^>]*src="([^"]+)"/i,
    // Standard og:image
    /og:image"\s*content="([^"]+)"/i,
    // Amazon desktop
    /id="landingImage"[^>]*src="([^"]+)"/i,
    /data-old-hires="([^"]+)"/,
    /"hiRes"\s*:\s*"([^"]+)"/,
    // Flipkart
    /class="[^"]*_396cs4[^"]*"[^>]*src="([^"]+)"/,
    // Myntra
    /class="[^"]*image-grid-image[^"]*"[^>]*src="([^"]+)"/i,
  ];
  for (const pat of patterns) {
    const m = html.match(pat);
    if (m && m[1].startsWith('http')) return m[1];
  }
  
  // Amazon fallback: extract thumbnail from data-a-dynamic-image and upscale
  const thumbMatch = html.match(/data-a-dynamic-image="[^"]*?(https:\/\/images-eu\.ssl-images-amazon\.com\/images\/I\/[^&"]+)/);
  if (thumbMatch) {
    return thumbMatch[1].replace(/\._[A-Z0-9_,]+_\./, '._SL500_.');
  }
  
  // Last resort: any Amazon product image ID
  const idMatch = html.match(/images-eu\.ssl-images-amazon\.com\/images\/I\/([a-zA-Z0-9]{10,})\./);
  if (idMatch) {
    return `https://m.media-amazon.com/images/I/${idMatch[1]}._SL500_.jpg`;
  }
  
  return null;
}

// --- SECURITY: Domain whitelist ---
const ALLOWED_DOMAINS = ['amazon.in', 'amzn.in', 'amazon.com', 'flipkart.com', 'myntra.com', 'tokopedia.com', 'zalora.co.id', 'zalora.com'];

function isAllowed(targetUrl) {
  try {
    const host = new URL(targetUrl).hostname;
    return ALLOWED_DOMAINS.some(d => host.includes(d));
  } catch(e) { return false; }
}

function detectStore(targetUrl) {
  const u = targetUrl.toLowerCase();
  if (u.includes('amazon') || u.includes('amzn')) return 'amazon';
  if (u.includes('flipkart')) return 'flipkart';
  if (u.includes('myntra')) return 'myntra';
  if (u.includes('tokopedia')) return 'tokopedia';
  if (u.includes('zalora')) return 'zalora';
  return 'unknown';
}

const server = http.createServer(async (req, res) => {
  const parsedUrl = url.parse(req.url, true);
  const targetUrl = parsedUrl.query.url;

  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  if (parsedUrl.pathname === '/scrape' && targetUrl) {
    if (!isAllowed(targetUrl)) {
      res.writeHead(403, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ success: false, error: 'Domain not allowed' }));
    }

    const store = detectStore(targetUrl);
    const isIndia = ['amazon', 'flipkart', 'myntra'].includes(store);
    const isIndo = ['tokopedia', 'zalora'].includes(store);
    console.log(`[Local Scraper] Store: ${store} | Fetching: ${targetUrl}`);

    // ============================================
    // TIER 1: Smart Raw HTTP Fetch
    // ============================================
    try {
      console.log(`[Tier 1] Attempting raw fetch...`);
      const { data, status, finalUrl } = await smartFetch(targetUrl);
      console.log(`[Tier 1] Got ${status} response, ${data.length} bytes`);
      
      if (status === 200 && data.length > 5000) {
        let price = null;
        
        if (store === 'amazon')    price = extractAmazonPrice(data);
        if (store === 'flipkart')  price = extractFlipkartPrice(data);
        if (store === 'myntra')    price = extractMyntraPrice(data);
        if (store === 'tokopedia') price = extractIndonesianPrice(data);
        if (store === 'zalora')    price = extractZaloraPrice(data);

        
        if (price && price > 0) {
          const name = extractName(data);
          const image = extractImage(data);
          const symbol = isIndia ? '₹' : 'Rp';
          console.log(`[Tier 1] ✅ Found price: ${symbol}${price}`);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ 
            success: true, 
            price: `${symbol}${price}`, 
            name: name || 'Product',
            image: image,
            tier: 1 
          }));
        } else {
          console.log(`[Tier 1] ❌ No price found in HTML, falling through to Tier 2...`);
        }
      } else {
        console.log(`[Tier 1] ❌ Bad response (status: ${status}, size: ${data.length})`);
      }
    } catch (e) {
      console.log(`[Tier 1] ❌ Fetch failed: ${e.message}`);
    }

    // ============================================
    // TIER 2: Playwright Headless Browser (fallback)
    // ============================================
    await acquireSlot();
    let context;
    try {
      console.log(`[Tier 2] Launching headless browser...`);
      const browser = await getBrowser();
      const isMyntra = store === 'myntra';
      context = await browser.newContext({
        userAgent: isMyntra 
          ? 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4.1 Mobile/15E148 Safari/604.1' 
          : 'Mozilla/5.0 (Linux; Android 14; SM-S928B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36',
        viewport: { width: 412, height: 915, isMobile: true },
        locale: 'en-IN',
        extraHTTPHeaders: { 
          'Accept-Language': 'en-US,en;q=0.9,hi;q=0.8',
          'Sec-CH-UA-Mobile': '?1',
          'Sec-CH-UA-Platform': '"Android"',
        }
      });
      const page = await context.newPage();
      
      // Anti-bot stealth
      await page.addInitScript(() => { 
        Object.defineProperty(navigator, 'webdriver', { get: () => false });
        Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en', 'hi'] });
        delete navigator.__proto__.webdriver;
        window.chrome = { runtime: {} };
      });
      
      try { 
        await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 30000 }); 
      } catch (e) { 
        console.log(`[Tier 2] Navigation partial: ${e.message}`);
      }
      
      await page.waitForTimeout(4000);
      await page.evaluate(() => window.scrollBy(0, 600));
      await page.waitForTimeout(2000);

      const scraped = await page.evaluate(({ isIndia, isIndo, store }) => {
        const query = (selectors) => { 
          for (const sel of selectors) { 
            const elements = document.querySelectorAll(sel);
            for (const el of elements) {
              const text = (el.innerText || el.textContent || '').trim();
              if (text && !text.includes('%') && text.length < 20) return text;
            }
          } 
          return null; 
        };

        let price = null;

        // --- Zalora-specific price extraction in browser ---
        if (store === 'zalora') {
          // Method 1: JSON-LD (most reliable)
          const ldScripts = document.querySelectorAll('script[type="application/ld+json"]');
          for (const s of ldScripts) {
            try {
              const ld = JSON.parse(s.textContent);
              const p = ld.offers?.price || (ld.offers && ld.offers.price);
              if (p) {
                const val = parseFloat(String(p).replace(/[^\d.]/g, ''));
                if (val > 1000) { price = 'Rp ' + val.toLocaleString('id-ID'); break; }
              }
            } catch(e) {}
          }
          
          // Method 2: Zalora's bold price div ("text-lg font-bold" containing Rp)
          if (!price) {
            const allDivs = document.querySelectorAll('div.text-lg.font-bold, div.font-bold');
            for (const d of allDivs) {
              const t = (d.innerText || '').trim();
              if (/^Rp\s/.test(t) && t.length < 20) {
                // Make sure parent context is NOT a promo ribbon
                const parentText = (d.parentElement?.innerText || '').toLowerCase();
                if (!/hadiah|dapatkan|voucher|kupon|cashback/i.test(parentText)) {
                  price = t; break;
                }
              }
            }
          }
          
          // Method 3: Filtered body text sweep for Zalora
          if (!price) {
            const bodyText = document.body.innerText;
            const matches = bodyText.match(/Rp\s?[1-9]\d{0,2}(?:[.,]\d{3})*/gi);
            if (matches) {
              const filtered = matches.filter(m => {
                const num = parseFloat(m.replace(/[^\d]/g, ''));
                return num > 10000 && !m.includes('+');
              });
              // Find the first price that isn't from promo text
              for (const m of filtered) {
                const idx = bodyText.indexOf(m);
                const ctx = bodyText.substring(Math.max(0, idx - 60), idx + m.length + 30);
                if (!/hadiah|Dapatkan|voucher|kupon|cashback/i.test(ctx)) {
                  price = m; break;
                }
              }
            }
          }
        }
        
        // --- Standard price extraction for other stores ---
        if (!price) {
          const priceSelectors = [
            '#corePrice_desktop .a-price-whole',
            '#corePriceDisplay_desktop_feature_div .a-price-whole',
            '.apexPriceToPay .a-price-whole',
            '#priceblock_dealprice', '#priceblock_ourprice',
            '.a-price-whole',
            '#newPrice .a-color-price', '.inlineBlock-display .a-color-price',
            '#apex_dp .a-color-price', '.a-price .a-offscreen',
            '#price_inside_buybox', '#newBuyBoxPrice',
            '.Nx9bqj._4b5DiR', '._30jeq3', '._16Jk6d', '.Nx9bqj', '.VU-Z7M',
            '.pdp-price strong', '.pdp-price',
            '[data-testid="lblPDPDetailProductPrice"]',
            '.pdp__price', '.product-price',
            '[data-testid="price-discounted"]',
            '.price', '[class*="price"]'
          ];
          
          price = query(priceSelectors);
        }
        
        if (!price || parseFloat(price.replace(/[^\d]/g, '')) < 1) {
          const bodyText = document.body.innerText;
          const regex = isIndia 
            ? /(₹|Rs\.?)\s?[1-9]\d{0,2}(,\d{3})*(\.\d{2})?|(₹|Rs\.?)\s?[1-9]\d+/gi 
            : /(?:Rp\.?|IDR)\s*[1-9]\d{0,2}(?:[.,]\d{3})*|(?:Rp\.?|IDR)\s*\d+/gi;
          const matches = bodyText.match(regex);
          if (matches) { 
            const filtered = matches.filter(m => {
              const num = parseFloat(m.replace(/[^\d]/g, ''));
              if (window.location.hostname.includes('amazon') && num < 100) return false;
              return num > 10 && !m.includes('+');
            }); 
            price = filtered.length > 0 ? filtered[0] : null; 
          }
        }
        
        const getName = () => {
          let n = query(['#productTitle', '#title', '.VU-Z7M', '.B_NuCI', '.Nx9bqj.CxhGGd', 'h1 span', 'h1']);
          if (n) n = n.split('|')[0].replace(/ - Buy.*/, '').replace(/: Amazon\.in.*/, '').trim();
          return n;
        };
        const getImg = () => { 
          const el = document.querySelector('#landingImage') || document.querySelector('#imgBlkFront') 
            || document.querySelector('.image-grid-image') || document.querySelector('._0_1ayN') 
            || document.querySelector('._396cs4') || document.querySelector('.pdp-main-image') 
            || document.querySelector('meta[property="og:image"]'); 
          return el ? (el.src || el.getAttribute('content')) : null; 
        };
        return { name: getName(), price, image: getImg() };
      }, { isIndia, isIndo, store });

      console.log(`[Tier 2] Result: price=${scraped.price}, name=${scraped.name ? 'found' : 'null'}`);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: !!scraped.price, ...scraped, tier: 2 }));
    } catch (err) {
      console.error(`[Tier 2] Error: ${err.message}`);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: false, error: err.message }));
    } finally { 
      if (context) await context.close(); 
      releaseSlot();
    }
    return;
  }

  // --- Static File Server ---
  let filePath = path.join(__dirname, parsedUrl.pathname === '/' ? 'index.html' : parsedUrl.pathname);
  if (!filePath.startsWith(__dirname)) { res.writeHead(403); res.end("Forbidden"); return; }
  fs.readFile(filePath, (err, content) => {
    if (err) { res.writeHead(err.code === 'ENOENT' ? 404 : 500); res.end(err.code === 'ENOENT' ? "404 Not Found" : "500 Server Error"); } 
    else { const ext = path.extname(filePath).toLowerCase(); res.writeHead(200, { 'Content-Type': MIME_TYPES[ext] || 'text/plain' }); res.end(content, 'utf-8'); }
  });
});

server.listen(PORT, () => { console.log(`🚀 Elmorae Optimized Local Server is running on port ${PORT}`); });
