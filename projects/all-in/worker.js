// ============================================================
// TESLA NEWS WORKER - Cloudflare Worker
// Sources: SEC EDGAR, Finnhub, Google News
// ============================================================

const SEEN_VERSION = "v4";

// ============================================================
// UTILITY FUNCTIONS
// ============================================================

async function hashUrl(url) {
  const encoder = new TextEncoder();
  const data = encoder.encode(url);
  const hashBuffer = await crypto.subtle.digest('SHA-256', data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map(b => b.toString(16).padStart(2, '0')).join('').slice(0, 32);
}

async function isUrlSeen(env, url) {
  const hash = await hashUrl(url);
  const seen = await env.SEEN_URLS.get(`${SEEN_VERSION}:${hash}`);
  return seen !== null;
}

async function markUrlSeen(env, url) {
  const hash = await hashUrl(url);
  await env.SEEN_URLS.put(`${SEEN_VERSION}:${hash}`, '1', { expirationTtl: 60 * 60 * 24 * 30 });
}

// ============================================================
// NEWS COLLECTORS
// ============================================================

async function collectSecEdgar(env) {
  const items = [];
  try {
    const url = 'https://data.sec.gov/submissions/CIK0001318605.json';
    const response = await fetch(url, {
      headers: {
        'User-Agent': 'TeslaNewsBot/1.0 (contact@example.com)',
        'Accept': 'application/json',
      },
    });

    if (!response.ok) {
      console.error('SEC EDGAR fetch failed:', response.status);
      return items;
    }

    const data = await response.json();
    const filings = data.filings?.recent || {};
    const forms = filings.form || [];
    const dates = filings.filingDate || [];
    const accessions = filings.accessionNumber || [];
    const primaryDocs = filings.primaryDocument || [];
    const descriptions = filings.primaryDocDescription || [];

    const allowedForms = ['8-K', '10-K', '10-Q', '4'];
    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - 365);

    for (let i = 0; i < forms.length; i++) {
      const form = forms[i];
      const filingDate = new Date(dates[i]);

      if (filingDate < cutoffDate) continue;
      if (!allowedForms.includes(form)) continue;

      const accessionFormatted = accessions[i].replace(/-/g, '');
      const filingUrl = `https://www.sec.gov/Archives/edgar/data/1318605/${accessionFormatted}/${primaryDocs[i]}`;

      if (await isUrlSeen(env, filingUrl)) continue;

      items.push({
        id: `sec-${accessions[i]}`,
        source: 'SEC EDGAR',
        title: `Tesla ${form} Filing: ${descriptions[i] || form}`,
        url: filingUrl,
        publishedAt: filingDate.toISOString(),
        summary: `Tesla Inc. filed form ${form} with the SEC`,
        category: 'filing',
        ticker: 'TSLA',
      });

      await markUrlSeen(env, filingUrl);
    }
  } catch (error) {
    console.error('SEC EDGAR collector error:', error);
  }
  return items;
}

async function collectFinnhubNews(env, finnhubKey) {
  const items = [];
  try {
    const now = new Date();
    const from = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
    const fromStr = from.toISOString().split('T')[0];
    const toStr = now.toISOString().split('T')[0];

    const url = `https://finnhub.io/api/v1/company-news?symbol=TSLA&from=${fromStr}&to=${toStr}&token=${finnhubKey}`;
    const response = await fetch(url);

    if (!response.ok) {
      console.error('Finnhub news fetch failed:', response.status);
      return items;
    }

    const news = await response.json();

    for (const article of news.slice(0, 20)) {
      if (await isUrlSeen(env, article.url)) continue;

      items.push({
        id: `finnhub-${article.id}`,
        source: article.source || 'Finnhub',
        title: article.headline,
        url: article.url,
        publishedAt: new Date(article.datetime * 1000).toISOString(),
        summary: article.summary?.slice(0, 500) || '',
        category: 'news',
        ticker: 'TSLA',
        image: article.image || null,
      });

      await markUrlSeen(env, article.url);
    }
  } catch (error) {
    console.error('Finnhub news collector error:', error);
  }
  return items;
}

async function collectGoogleNews(env) {
  const items = [];
  try {
    const url = 'https://news.google.com/rss/search?q=TSLA+stock+OR+Tesla+Inc&hl=en-US&gl=US&ceid=US:en';
    const response = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; TeslaNewsBot/1.0)',
      },
    });

    if (!response.ok) {
      console.error('Google News fetch failed:', response.status);
      return items;
    }

    const xml = await response.text();

    const itemRegex = /<item>([\s\S]*?)<\/item>/g;
    const titleRegex = /<title><!\[CDATA\[(.*?)\]\]><\/title>|<title>(.*?)<\/title>/;
    const linkRegex = /<link>(.*?)<\/link>/;
    const pubDateRegex = /<pubDate>(.*?)<\/pubDate>/;
    const sourceRegex = /<source.*?>(.*?)<\/source>/;

    let match;
    let count = 0;

    while ((match = itemRegex.exec(xml)) !== null && count < 15) {
      const itemXml = match[1];

      const titleMatch = itemXml.match(titleRegex);
      const linkMatch = itemXml.match(linkRegex);
      const pubDateMatch = itemXml.match(pubDateRegex);
      const sourceMatch = itemXml.match(sourceRegex);

      const title = titleMatch ? (titleMatch[1] || titleMatch[2]) : '';
      const link = linkMatch ? linkMatch[1] : '';
      const pubDate = pubDateMatch ? pubDateMatch[1] : '';
      const source = sourceMatch ? sourceMatch[1] : 'Google News';

      if (!link || await isUrlSeen(env, link)) continue;

      items.push({
        id: `google-${await hashUrl(link)}`,
        source: source,
        title: title,
        url: link,
        publishedAt: pubDate ? new Date(pubDate).toISOString() : new Date().toISOString(),
        summary: '',
        category: 'news',
        ticker: 'TSLA',
      });

      await markUrlSeen(env, link);
      count++;
    }
  } catch (error) {
    console.error('Google News collector error:', error);
  }
  return items;
}

// ============================================================
// STORAGE FUNCTIONS
// ============================================================

async function getStoredNews(env, ticker = 'TSLA') {
  const key = `news:${ticker}`;
  const stored = await env.NEWS_STORE.get(key);
  if (!stored) return [];
  try {
    return JSON.parse(stored);
  } catch {
    return [];
  }
}

async function storeNews(env, items, ticker = 'TSLA') {
  if (!items || items.length === 0) return { added: 0, total: 0 };

  const key = `news:${ticker}`;
  const existing = await getStoredNews(env, ticker);

  const existingIds = new Set(existing.map(n => n.id));
  const newItems = items.filter(n => !existingIds.has(n.id));

  const combined = [...newItems, ...existing]
    .sort((a, b) => new Date(b.publishedAt) - new Date(a.publishedAt))
    .slice(0, 500); // Increased from 200 to hold more SEC filings

  await env.NEWS_STORE.put(key, JSON.stringify(combined), {
    expirationTtl: 60 * 60 * 24 * 7,
  });

  return { added: newItems.length, total: combined.length };
}

// ============================================================
// NEWS COLLECTION ORCHESTRATOR
// ============================================================

async function runNewsCollection(env) {
  const finnhubKey = env.FINNHUB_API_KEY_ENV;

  console.log('Starting news collection...');

  const [secItems, finnhubItems, googleItems] = await Promise.all([
    collectSecEdgar(env),
    collectFinnhubNews(env, finnhubKey),
    collectGoogleNews(env),
  ]);

  const allItems = [...secItems, ...finnhubItems, ...googleItems];

  console.log(`Collected: SEC=${secItems.length}, Finnhub=${finnhubItems.length}, Google=${googleItems.length}`);

  const result = await storeNews(env, allItems, 'TSLA');

  console.log(`Storage result: added=${result.added}, total=${result.total}`);

  return {
    collected: {
      sec: secItems.length,
      finnhub: finnhubItems.length,
      google: googleItems.length,
      total: allItems.length,
    },
    stored: result,
  };
}

// ============================================================
// CORS HEADERS
// ============================================================

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

// ============================================================
// MAIN WORKER EXPORT
// ============================================================

export default {
  async fetch(request, env, ctx) {
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders });
    }

    try {
      const url = new URL(request.url);
      const path = url.pathname;

      // API Keys
      const ALPACA_KEY_ID = env.ALPACA_KEY_ID_ENV;
      const ALPACA_SECRET_KEY = env.ALPACA_SECRET_KEY_ENV;
      const FINNHUB_KEY = env.FINNHUB_API_KEY_ENV;
      const FMP_KEY = env.FMP_API_KEY_ENV;

      const alpacaHeaders = {
        'APCA-API-KEY-ID': ALPACA_KEY_ID,
        'APCA-API-SECRET-KEY': ALPACA_SECRET_KEY,
      };

      const yahooHeaders = {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Accept': 'application/json',
      };

      let targetUrl;

      // ============================================================
      // NITTER/TWITTER ROUTES
      // ============================================================

      // GET /nitter/:username - Fetch tweets from Nitter HTML page
      if (path.startsWith('/nitter/')) {
        const username = path.split('/')[2];
        const tweets = [];

        try {
          const instances = ['nitter.net', 'nitter.privacydev.net', 'nitter.poast.org'];
          let html = null;

          // Browser-like headers
          const browserHeaders = {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
            'Accept-Language': 'en-US,en;q=0.5',
            'Accept-Encoding': 'gzip, deflate, br',
            'Connection': 'keep-alive',
            'Upgrade-Insecure-Requests': '1',
            'Sec-Fetch-Dest': 'document',
            'Sec-Fetch-Mode': 'navigate',
            'Sec-Fetch-Site': 'none',
            'Sec-Fetch-User': '?1',
            'Cache-Control': 'max-age=0'
          };

          for (const instance of instances) {
            try {
              // Try HTML page scraping
              const res = await fetch(`https://${instance}/${username}`, {
                headers: browserHeaders
              });
              if (res.ok) {
                html = await res.text();
                if (html && html.includes('timeline-item')) break;
              }
            } catch {}
          }

          if (html) {
            // Parse timeline items from HTML
            // Nitter structure: <div class="timeline-item"> contains each tweet
            const timelineItemRegex = /<div class="timeline-item[^"]*">([\s\S]*?)<\/div>\s*<\/div>\s*<\/div>/g;
            const contentRegex = /<div class="tweet-content[^"]*"[^>]*>([\s\S]*?)<\/div>/;
            const linkRegex = /<a class="tweet-link"[^>]*href="([^"]+)"/;
            const dateRegex = /<span class="tweet-date"[^>]*><a[^>]*title="([^"]+)"/;

            let match;
            while ((match = timelineItemRegex.exec(html)) !== null && tweets.length < 15) {
              const itemHtml = match[1];
              const contentMatch = itemHtml.match(contentRegex);
              const linkMatch = itemHtml.match(linkRegex);
              const dateMatch = itemHtml.match(dateRegex);

              if (contentMatch) {
                // Strip HTML tags from content
                const text = contentMatch[1]
                  .replace(/<[^>]+>/g, ' ')
                  .replace(/&amp;/g, '&')
                  .replace(/&lt;/g, '<')
                  .replace(/&gt;/g, '>')
                  .replace(/&quot;/g, '"')
                  .replace(/&#39;/g, "'")
                  .replace(/\s+/g, ' ')
                  .trim();

                if (text) {
                  tweets.push({
                    text: text,
                    url: linkMatch ? `https://x.com${linkMatch[1].replace(/^\/[^/]+/, '')}` : '',
                    date: dateMatch ? new Date(dateMatch[1]).toISOString() : null
                  });
                }
              }
            }
          }
        } catch (error) {
          console.error('Nitter fetch error:', error);
        }

        return new Response(JSON.stringify(tweets), {
          headers: { ...corsHeaders, 'Content-Type': 'application/json' }
        });
      }

      // ============================================================
      // NEWS ROUTES
      // ============================================================

      // GET /news/cnbc/:ticker - CNBC headlines via Google News
      if (path.startsWith('/news/cnbc/')) {
        const ticker = path.split('/')[3];
        const items = [];

        try {
          const query = encodeURIComponent(`${ticker} earnings site:cnbc.com`);
          const rssUrl = `https://news.google.com/rss/search?q=${query}&hl=en-US&gl=US&ceid=US:en`;

          const response = await fetch(rssUrl, {
            headers: { 'User-Agent': 'Mozilla/5.0 (compatible; TeslaNewsBot/1.0)' }
          });

          if (response.ok) {
            const xml = await response.text();
            const itemRegex = /<item>([\s\S]*?)<\/item>/g;
            const titleRegex = /<title><!\[CDATA\[(.*?)\]\]><\/title>|<title>(.*?)<\/title>/;
            const linkRegex = /<link>(.*?)<\/link>/;
            const pubDateRegex = /<pubDate>(.*?)<\/pubDate>/;

            let match;
            while ((match = itemRegex.exec(xml)) !== null && items.length < 10) {
              const itemXml = match[1];
              const titleMatch = itemXml.match(titleRegex);
              const linkMatch = itemXml.match(linkRegex);
              const pubDateMatch = itemXml.match(pubDateRegex);

              items.push({
                source: 'CNBC',
                title: titleMatch ? (titleMatch[1] || titleMatch[2]) : '',
                url: linkMatch ? linkMatch[1] : '',
                publishedAt: pubDateMatch ? new Date(pubDateMatch[1]).toISOString() : new Date().toISOString()
              });
            }
          }
        } catch (error) {
          console.error('CNBC news fetch error:', error);
        }

        return new Response(JSON.stringify(items), {
          headers: { ...corsHeaders, 'Content-Type': 'application/json' }
        });
      }

      // GET /news/TSLA - Retrieve stored news
      if (path === '/news/TSLA' || path === '/news/TSLA/') {
        const allNews = await getStoredNews(env, 'TSLA');

        // Sort by date (newest first)
        allNews.sort((a, b) => new Date(b.publishedAt) - new Date(a.publishedAt));

        // Optional filters
        const category = url.searchParams.get('category');
        const source = url.searchParams.get('source');
        const limit = parseInt(url.searchParams.get('limit') || '100', 10);

        let filtered = allNews;
        if (category) {
          filtered = filtered.filter(n => n.category === category);
        }
        if (source) {
          filtered = filtered.filter(n => n.source.toLowerCase().includes(source.toLowerCase()));
        }

        const results = filtered.slice(0, limit);

        return new Response(JSON.stringify({
          ticker: 'TSLA',
          count: results.length,
          totalStored: allNews.length,
          news: results,
        }), {
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }

      // GET /news/update - Trigger news collection
      if (path === '/news/update' || path === '/news/update/') {
        const result = await runNewsCollection(env);

        return new Response(JSON.stringify({
          success: true,
          ...result,
          timestamp: new Date().toISOString(),
        }), {
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }

      // GET /news/reset - Clear news cache
      if (path === '/news/reset' || path === '/news/reset/') {
        await env.NEWS_STORE.delete('news:TSLA');

        return new Response(JSON.stringify({
          success: true,
          message: 'News cache cleared. Run /news/update to re-collect.',
        }), {
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }

      // ============================================================
      // FINNHUB ROUTES
      // ============================================================

      // GET /finnhub/ws-url - WebSocket URL with token
      if (path === '/finnhub/ws-url' || path === '/finnhub/ws-url/') {
        return new Response(JSON.stringify({
          url: `wss://ws.finnhub.io?token=${FINNHUB_KEY}`,
        }), {
          headers: { ...corsHeaders, 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
        });
      }

      // GET /finnhub/metric/:symbol - Fundamentals
      if (path.startsWith('/finnhub/metric/')) {
        const symbol = path.split('/')[3];
        const cache = caches.default;
        const cacheKey = new Request(url.toString(), request);
        let response = await cache.match(cacheKey);

        if (!response) {
          targetUrl = `https://finnhub.io/api/v1/stock/metric?symbol=${symbol}&metric=all&token=${FINNHUB_KEY}`;
          response = await fetch(targetUrl);

          if (response.ok) {
            response = new Response(response.body, {
              headers: { ...corsHeaders, 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=3600' },
            });
            ctx.waitUntil(cache.put(cacheKey, response.clone()));
          }
        }
        return response;
      }

      // GET /finnhub/quote/:symbol - Quote data
      if (path.startsWith('/finnhub/quote/')) {
        const symbol = path.split('/')[3];
        const cache = caches.default;
        let response = await cache.match(request);

        if (!response) {
          targetUrl = `https://finnhub.io/api/v1/quote?symbol=${symbol}&token=${FINNHUB_KEY}`;
          response = await fetch(targetUrl);

          if (response.ok) {
            response = new Response(response.body, {
              headers: { ...corsHeaders, 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=15' },
            });
            ctx.waitUntil(cache.put(request, response.clone()));
          }
        }
        return response;
      }

      // GET /finnhub/earnings/:symbol - Earnings data (estimates & actuals)
      if (path.startsWith('/finnhub/earnings/')) {
        const symbol = path.split('/')[3];
        const cache = caches.default;
        let response = await cache.match(request);

        if (!response) {
          targetUrl = `https://finnhub.io/api/v1/stock/earnings?symbol=${symbol}&token=${FINNHUB_KEY}`;
          response = await fetch(targetUrl);

          if (response.ok) {
            response = new Response(response.body, {
              headers: { ...corsHeaders, 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=30' },
            });
            ctx.waitUntil(cache.put(request, response.clone()));
          }
        }
        return response;
      }

      // GET /finnhub/revenue-estimate/:symbol - Revenue estimates
      if (path.startsWith('/finnhub/revenue-estimate/')) {
        const symbol = path.split('/')[3];
        const cache = caches.default;
        let response = await cache.match(request);

        if (!response) {
          targetUrl = `https://finnhub.io/api/v1/stock/revenue-estimate?symbol=${symbol}&freq=quarterly&token=${FINNHUB_KEY}`;
          response = await fetch(targetUrl);

          if (response.ok) {
            response = new Response(response.body, {
              headers: { ...corsHeaders, 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=30' },
            });
            ctx.waitUntil(cache.put(request, response.clone()));
          }
        }
        return response;
      }

      // ============================================================
      // FMP ROUTES
      // ============================================================

      // GET /fmp/shares-float/:symbol
      if (path.startsWith('/fmp/shares-float/')) {
        const symbol = path.split('/')[3];
        targetUrl = `https://financialmodelingprep.com/stable/shares-float?symbol=${symbol}&apikey=${FMP_KEY}`;

        const response = await fetch(targetUrl);
        return new Response(response.body, {
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }

      // GET /fmp/analyst-estimates/:symbol - EPS & Revenue estimates
      if (path.startsWith('/fmp/analyst-estimates/')) {
        const symbol = path.split('/')[3];
        targetUrl = `https://financialmodelingprep.com/stable/analyst-estimates?symbol=${symbol}&period=quarter&limit=5&apikey=${FMP_KEY}`;

        const response = await fetch(targetUrl);
        return new Response(response.body, {
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }

      // GET /fmp/earnings-surprises/:symbol - Actual earnings results
      if (path.startsWith('/fmp/earnings-surprises/')) {
        const symbol = path.split('/')[3];
        targetUrl = `https://financialmodelingprep.com/api/v3/earnings-surprises/${symbol}?apikey=${FMP_KEY}`;

        const response = await fetch(targetUrl);
        return new Response(response.body, {
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }

      // ============================================================
      // ALPHAVANTAGE ROUTES
      // ============================================================

      // GET /alphavantage/earnings/:symbol - EPS data with estimates
      if (path.startsWith('/alphavantage/earnings/')) {
        const symbol = path.split('/')[3];
        const ALPHAVANTAGE_KEY = env.ALPHA_VANTAGE_KEY_ENV;

        if (!ALPHAVANTAGE_KEY) {
          return new Response(JSON.stringify({ error: 'AlphaVantage API key not configured' }), {
            status: 500,
            headers: { ...corsHeaders, 'Content-Type': 'application/json' }
          });
        }

        const cache = caches.default;
        let response = await cache.match(request);

        if (!response) {
          targetUrl = `https://www.alphavantage.co/query?function=EARNINGS&symbol=${symbol}&apikey=${ALPHAVANTAGE_KEY}`;
          const avResponse = await fetch(targetUrl);

          if (avResponse.ok) {
            const data = await avResponse.json();

            // Check for API limit message
            if (data['Note'] || data['Information']) {
              return new Response(JSON.stringify({
                error: 'API rate limit',
                message: data['Note'] || data['Information'],
                source: 'alphavantage'
              }), {
                status: 429,
                headers: { ...corsHeaders, 'Content-Type': 'application/json' }
              });
            }

            // Transform to normalized format
            const normalized = {
              source: 'alphavantage',
              ticker: symbol,
              quarterlyEarnings: (data.quarterlyEarnings || []).slice(0, 12).map(q => ({
                fiscalDateEnding: q.fiscalDateEnding,
                reportedEPS: q.reportedEPS !== 'None' ? parseFloat(q.reportedEPS) : null,
                estimatedEPS: q.estimatedEPS !== 'None' ? parseFloat(q.estimatedEPS) : null,
                surprise: q.surprise !== 'None' ? parseFloat(q.surprise) : null,
                surprisePercentage: q.surprisePercentage !== 'None' ? parseFloat(q.surprisePercentage) : null,
                reportedDate: q.reportedDate
              }))
            };

            response = new Response(JSON.stringify(normalized), {
              headers: {
                ...corsHeaders,
                'Content-Type': 'application/json',
                'Cache-Control': 'public, max-age=60'
              }
            });
            ctx.waitUntil(cache.put(request, response.clone()));
          } else {
            return new Response(JSON.stringify({ error: `AlphaVantage returned ${avResponse.status}` }), {
              status: avResponse.status,
              headers: { ...corsHeaders, 'Content-Type': 'application/json' }
            });
          }
        }
        return response;
      }

      // ============================================================
      // EDGAR XBRL ROUTES
      // ============================================================

      // CIK lookup map
      const CIK_MAP = {
        'TSLA': '0001318605',
        'AAPL': '0000320193',
        'MSFT': '0000789019',
        'GOOGL': '0001652044',
        'GOOG': '0001652044',
        'AMZN': '0001018724',
        'META': '0001326801',
        'NVDA': '0001045810',
      };

      // GET /edgar/earnings/:symbol - Parse XBRL for EPS and revenue
      if (path.startsWith('/edgar/earnings/')) {
        const symbol = path.split('/')[3].toUpperCase();
        const cik = CIK_MAP[symbol];

        if (!cik) {
          return new Response(JSON.stringify({ error: 'CIK not found for symbol', symbol }), {
            status: 404,
            headers: { ...corsHeaders, 'Content-Type': 'application/json' }
          });
        }

        const cache = caches.default;
        let response = await cache.match(request);

        if (!response) {
          try {
            // Fetch company facts (contains all XBRL data)
            const factsUrl = `https://data.sec.gov/api/xbrl/companyfacts/CIK${cik}.json`;
            const factsRes = await fetch(factsUrl, {
              headers: {
                'User-Agent': 'EarningsDashboard/1.0 (contact@hjd.ai)',
                'Accept': 'application/json'
              }
            });

            if (!factsRes.ok) {
              throw new Error(`SEC API returned ${factsRes.status}`);
            }

            const facts = await factsRes.json();
            const usGaap = facts.facts?.['us-gaap'] || {};

            // Extract EPS (basic diluted) - try multiple possible keys
            const epsData = usGaap['EarningsPerShareDiluted']?.units?.['USD/shares'] ||
                            usGaap['EarningsPerShareBasic']?.units?.['USD/shares'] ||
                            usGaap['EarningsPerShareBasicAndDiluted']?.units?.['USD/shares'] || [];

            // Extract Revenue - try multiple possible keys
            const revenueData = usGaap['Revenues']?.units?.USD ||
                                usGaap['RevenueFromContractWithCustomerExcludingAssessedTax']?.units?.USD ||
                                usGaap['SalesRevenueNet']?.units?.USD ||
                                usGaap['RevenueFromContractWithCustomerIncludingAssessedTax']?.units?.USD || [];

            // Filter to quarterly (10-Q) and annual (10-K) filings, recent first
            const filterAndSort = (data) => {
              return data
                .filter(f => f.form === '10-Q' || f.form === '10-K' || f.form === '8-K')
                .filter(f => f.fp && f.fy) // Must have fiscal period info
                .sort((a, b) => {
                  // Sort by fiscal year desc, then by quarter desc
                  if (b.fy !== a.fy) return b.fy - a.fy;
                  const qOrder = { 'FY': 5, 'Q4': 4, 'Q3': 3, 'Q2': 2, 'Q1': 1 };
                  return (qOrder[b.fp] || 0) - (qOrder[a.fp] || 0);
                });
            };

            const sortedEps = filterAndSort(epsData);
            const sortedRevenue = filterAndSort(revenueData);

            // Transform to normalized format
            const normalized = {
              source: 'edgar',
              ticker: symbol,
              cik: cik,
              earnings: sortedEps.slice(0, 20).map(e => ({
                fiscalPeriod: e.fp,       // Q1, Q2, Q3, Q4, FY
                fiscalYear: e.fy,
                value: e.val,
                filed: e.filed,
                form: e.form,
                accn: e.accn,
                start: e.start,
                end: e.end
              })),
              revenue: sortedRevenue.slice(0, 20).map(r => ({
                fiscalPeriod: r.fp,
                fiscalYear: r.fy,
                value: r.val,
                filed: r.filed,
                form: r.form,
                accn: r.accn,
                start: r.start,
                end: r.end
              }))
            };

            response = new Response(JSON.stringify(normalized), {
              headers: {
                ...corsHeaders,
                'Content-Type': 'application/json',
                'Cache-Control': 'public, max-age=300'
              }
            });
            ctx.waitUntil(cache.put(request, response.clone()));

          } catch (error) {
            console.error('EDGAR earnings fetch error:', error);
            return new Response(JSON.stringify({ error: error.message, source: 'edgar' }), {
              status: 500,
              headers: { ...corsHeaders, 'Content-Type': 'application/json' }
            });
          }
        }
        return response;
      }

      // ============================================================
      // UNIFIED EARNINGS (RACING) ROUTES
      // ============================================================

      // Helper: Extract quarter from date string
      function extractQuarterFromDate(dateStr) {
        if (!dateStr) return null;
        const date = new Date(dateStr);
        const month = date.getMonth() + 1;
        const year = date.getFullYear();
        let quarter;
        if (month <= 3) quarter = 1;
        else if (month <= 6) quarter = 2;
        else if (month <= 9) quarter = 3;
        else quarter = 4;
        return { year, quarter, key: `${year}-Q${quarter}` };
      }

      // Helper: Normalize earnings data from different sources
      function normalizeEarningsData(result) {
        const { source, data } = result;

        if (!data) return null;

        switch (source) {
          case 'fmp': {
            // FMP analyst-estimates format
            const estimates = Array.isArray(data) ? data : [];
            const latest = estimates[0];
            if (!latest) return null;

            const qInfo = extractQuarterFromDate(latest.date);
            return {
              quarter: qInfo?.key || 'Unknown',
              fiscalYear: qInfo?.year,
              fiscalQuarter: qInfo?.quarter,
              eps: {
                estimate: latest.estimatedEpsAvg || latest.estimatedEpsHigh || null,
                actual: null
              },
              revenue: {
                estimate: latest.estimatedRevenueAvg || latest.estimatedRevenueHigh || null,
                actual: null
              },
              source: 'fmp'
            };
          }

          case 'fmp-surprises': {
            // FMP earnings-surprises format (actuals)
            const surprises = Array.isArray(data) ? data : [];
            const latest = surprises[0];
            if (!latest) return null;

            const qInfo = extractQuarterFromDate(latest.date);
            return {
              quarter: qInfo?.key || 'Unknown',
              fiscalYear: qInfo?.year,
              fiscalQuarter: qInfo?.quarter,
              eps: {
                estimate: latest.estimatedEarning,
                actual: latest.actualEarningResult
              },
              revenue: {
                estimate: null,
                actual: null
              },
              source: 'fmp'
            };
          }

          case 'alphavantage': {
            const latest = data.quarterlyEarnings?.[0];
            if (!latest) return null;

            const qInfo = extractQuarterFromDate(latest.fiscalDateEnding);
            return {
              quarter: qInfo?.key || 'Unknown',
              fiscalYear: qInfo?.year,
              fiscalQuarter: qInfo?.quarter,
              eps: {
                estimate: latest.estimatedEPS,
                actual: latest.reportedEPS
              },
              revenue: {
                estimate: null,
                actual: null
              },
              source: 'alphavantage'
            };
          }

          case 'finnhub': {
            // Finnhub returns array: [{ actual, estimate, period, quarter, year, surprise, surprisePercent }]
            const earnings = Array.isArray(data) ? data : [];
            const latest = earnings[0];
            if (!latest) return null;

            return {
              quarter: `${latest.year}-Q${latest.quarter}`,
              fiscalYear: latest.year,
              fiscalQuarter: latest.quarter,
              eps: {
                estimate: latest.estimate,
                actual: latest.actual
              },
              revenue: {
                estimate: null,
                actual: null
              },
              source: 'finnhub'
            };
          }

          case 'finnhub-revenue': {
            // Finnhub revenue estimate: { data: [{ period, revenueAvg, revenueHigh, revenueLow }], freq, symbol }
            const estimates = data?.data;
            if (!Array.isArray(estimates) || estimates.length === 0) return null;
            const latest = estimates[0];
            if (!latest) return null;

            const qInfo = extractQuarterFromDate(latest.period);
            return {
              quarter: qInfo?.key || 'Unknown',
              fiscalYear: qInfo?.year,
              fiscalQuarter: qInfo?.quarter,
              eps: {
                estimate: null,
                actual: null
              },
              revenue: {
                estimate: latest.revenueAvg || latest.revenueHigh || null,
                actual: null
              },
              source: 'finnhub'
            };
          }

          case 'edgar': {
            // EDGAR is used for REVENUE only - Finnhub is authoritative for EPS
            const latestRevenue = data.revenue?.[0];
            if (!latestRevenue) return null;

            const fp = latestRevenue.fiscalPeriod || latestRevenue.fp;
            const fy = latestRevenue.fiscalYear || latestRevenue.fy;
            const revVal = latestRevenue.value ?? latestRevenue.val ?? null;

            return {
              quarter: `${fy}-${fp}`,
              fiscalYear: fy,
              fiscalQuarter: fp === 'FY' ? 4 : parseInt(String(fp).replace('Q', '')),
              eps: {
                estimate: null,
                actual: null  // Don't use EDGAR for EPS - Finnhub is authoritative
              },
              revenue: {
                estimate: null,
                actual: revVal
              },
              source: 'edgar'
            };
          }

          default:
            return null;
        }
      }

      // Helper: Merge results from multiple sources
      function mergeEarningsResults(results) {
        const merged = {
          eps: { estimate: null, actual: null, surprise: null, surprisePercent: null },
          revenue: { estimate: null, actual: null, surprise: null, surprisePercent: null },
          sources: {
            eps: { estimate: [], actual: [] },
            revenue: { estimate: [], actual: [] }
          },
          fiscalYear: null,
          fiscalQuarter: null,
          quarter: null
        };
        const discrepancies = [];

        for (const result of results) {
          const normalized = normalizeEarningsData(result);
          if (!normalized) continue;

          // Set quarter info from first valid result
          if (!merged.quarter && normalized.quarter) {
            merged.quarter = normalized.quarter;
            merged.fiscalYear = normalized.fiscalYear;
            merged.fiscalQuarter = normalized.fiscalQuarter;
          }

          // EPS estimate
          if (normalized.eps?.estimate != null) {
            if (merged.eps.estimate != null &&
                Math.abs(merged.eps.estimate - normalized.eps.estimate) > 0.02) {
              discrepancies.push({
                field: 'eps.estimate',
                existing: merged.eps.estimate,
                existingSource: merged.sources.eps.estimate[0],
                new: normalized.eps.estimate,
                newSource: normalized.source
              });
            }
            if (merged.eps.estimate == null) {
              merged.eps.estimate = normalized.eps.estimate;
            }
            merged.sources.eps.estimate.push(normalized.source);
          }

          // EPS actual
          if (normalized.eps?.actual != null) {
            if (merged.eps.actual != null &&
                Math.abs(merged.eps.actual - normalized.eps.actual) > 0.02) {
              discrepancies.push({
                field: 'eps.actual',
                existing: merged.eps.actual,
                existingSource: merged.sources.eps.actual[0],
                new: normalized.eps.actual,
                newSource: normalized.source
              });
            }
            // Prefer EDGAR for actuals (official filings)
            if (merged.eps.actual == null || normalized.source === 'edgar') {
              merged.eps.actual = normalized.eps.actual;
            }
            merged.sources.eps.actual.push(normalized.source);
          }

          // Revenue estimate
          if (normalized.revenue?.estimate != null) {
            if (merged.revenue.estimate == null) {
              merged.revenue.estimate = normalized.revenue.estimate;
            }
            merged.sources.revenue.estimate.push(normalized.source);
          }

          // Revenue actual
          if (normalized.revenue?.actual != null) {
            // Prefer EDGAR for actuals
            if (merged.revenue.actual == null || normalized.source === 'edgar') {
              merged.revenue.actual = normalized.revenue.actual;
            }
            merged.sources.revenue.actual.push(normalized.source);
          }
        }

        // Calculate surprises
        if (merged.eps.estimate != null && merged.eps.actual != null) {
          merged.eps.surprise = merged.eps.actual - merged.eps.estimate;
          merged.eps.surprisePercent = (merged.eps.surprise / Math.abs(merged.eps.estimate)) * 100;
        }

        if (merged.revenue.estimate != null && merged.revenue.actual != null) {
          merged.revenue.surprise = merged.revenue.actual - merged.revenue.estimate;
          merged.revenue.surprisePercent = (merged.revenue.surprise / merged.revenue.estimate) * 100;
        }

        // Calculate confidence
        const allSources = new Set([
          ...merged.sources.eps.estimate,
          ...merged.sources.eps.actual,
          ...merged.sources.revenue.estimate,
          ...merged.sources.revenue.actual
        ]);

        let confidence = 'single';
        if (allSources.size >= 2 && discrepancies.length === 0) {
          confidence = 'validated';
        } else if (allSources.size >= 2) {
          confidence = 'partial';
        }

        return { data: merged, confidence, discrepancies };
      }

      // GET /earnings/unified/:symbol - Race or merge all sources
      if (path.startsWith('/earnings/unified/')) {
        const symbol = path.split('/')[3];
        const mode = url.searchParams.get('mode') || 'race';
        const ALPHAVANTAGE_KEY = env.ALPHA_VANTAGE_KEY_ENV;

        // CIK for EDGAR lookup
        const cikMap = {
          'TSLA': '0001318605',
          'AAPL': '0000320193',
          'MSFT': '0000789019',
          'GOOGL': '0001652044',
          'AMZN': '0001018724',
          'META': '0001326801',
          'NVDA': '0001045810',
        };

        // Direct API fetch functions (not self-referential)
        const fetchEdgar = async () => {
          try {
            const cik = cikMap[symbol.toUpperCase()];
            if (!cik) return { source: 'edgar', error: 'CIK not found', timestamp: Date.now() };

            const factsUrl = `https://data.sec.gov/api/xbrl/companyfacts/CIK${cik}.json`;
            const res = await fetch(factsUrl, {
              headers: {
                'User-Agent': 'EarningsDashboard/1.0 (contact@hjd.ai)',
                'Accept': 'application/json'
              }
            });

            if (!res.ok) return { source: 'edgar', error: `HTTP ${res.status}`, timestamp: Date.now() };

            const facts = await res.json();
            const usGaap = facts.facts?.['us-gaap'] || {};

            const epsData = usGaap['EarningsPerShareDiluted']?.units?.['USD/shares'] ||
                            usGaap['EarningsPerShareBasic']?.units?.['USD/shares'] || [];
            const revenueData = usGaap['Revenues']?.units?.USD ||
                                usGaap['RevenueFromContractWithCustomerExcludingAssessedTax']?.units?.USD || [];

            // Filter to quarterly data only (not YTD cumulative), most recent first
            const filterQuarterly = (data) => data
              .filter(f => {
                if (!f.fp || !f.fy || !f.start || !f.end) return false;
                // Skip annual/FY entries
                if (f.fp === 'FY') return false;

                const startDate = new Date(f.start);
                const endDate = new Date(f.end);
                const daysDiff = (endDate - startDate) / (1000 * 60 * 60 * 24);

                // Quarterly = ~90 days. Skip YTD cumulative (180, 270, 365 days)
                if (daysDiff > 100) return false;

                return true;
              })
              .sort((a, b) => new Date(b.end) - new Date(a.end));

            return {
              source: 'edgar',
              data: {
                source: 'edgar',
                ticker: symbol,
                earnings: [],  // Don't use EDGAR for EPS
                revenue: filterQuarterly(revenueData).slice(0, 12)
              },
              timestamp: Date.now()
            };
          } catch (e) {
            return { source: 'edgar', error: e.message, timestamp: Date.now() };
          }
        };

        const fetchFmpEstimates = async () => {
          try {
            const res = await fetch(`https://financialmodelingprep.com/stable/analyst-estimates?symbol=${symbol}&period=quarter&limit=5&apikey=${FMP_KEY}`);
            if (!res.ok) return { source: 'fmp', error: `HTTP ${res.status}`, timestamp: Date.now() };
            const data = await res.json();
            if (typeof data === 'string' || data.error) return { source: 'fmp', error: data.error || 'Invalid response', timestamp: Date.now() };
            return { source: 'fmp', data, timestamp: Date.now() };
          } catch (e) {
            return { source: 'fmp', error: e.message, timestamp: Date.now() };
          }
        };

        const fetchFmpSurprises = async () => {
          try {
            const res = await fetch(`https://financialmodelingprep.com/api/v3/earnings-surprises/${symbol}?apikey=${FMP_KEY}`);
            if (!res.ok) return { source: 'fmp-surprises', error: `HTTP ${res.status}`, timestamp: Date.now() };
            const data = await res.json();
            if (typeof data === 'string' || data.error) return { source: 'fmp-surprises', error: data.error || 'Invalid response', timestamp: Date.now() };
            return { source: 'fmp-surprises', data, timestamp: Date.now() };
          } catch (e) {
            return { source: 'fmp-surprises', error: e.message, timestamp: Date.now() };
          }
        };

        const fetchAlphaVantage = async () => {
          try {
            if (!ALPHAVANTAGE_KEY) return { source: 'alphavantage', error: 'API key not configured', timestamp: Date.now() };
            const res = await fetch(`https://www.alphavantage.co/query?function=EARNINGS&symbol=${symbol}&apikey=${ALPHAVANTAGE_KEY}`);
            if (!res.ok) return { source: 'alphavantage', error: `HTTP ${res.status}`, timestamp: Date.now() };
            const data = await res.json();
            if (data['Note'] || data['Information']) return { source: 'alphavantage', error: 'Rate limited', timestamp: Date.now() };
            const normalized = {
              source: 'alphavantage',
              ticker: symbol,
              quarterlyEarnings: (data.quarterlyEarnings || []).slice(0, 12).map(q => ({
                fiscalDateEnding: q.fiscalDateEnding,
                reportedEPS: q.reportedEPS !== 'None' ? parseFloat(q.reportedEPS) : null,
                estimatedEPS: q.estimatedEPS !== 'None' ? parseFloat(q.estimatedEPS) : null,
                surprise: q.surprise !== 'None' ? parseFloat(q.surprise) : null,
                surprisePercentage: q.surprisePercentage !== 'None' ? parseFloat(q.surprisePercentage) : null,
              }))
            };
            return { source: 'alphavantage', data: normalized, timestamp: Date.now() };
          } catch (e) {
            return { source: 'alphavantage', error: e.message, timestamp: Date.now() };
          }
        };

        // Finnhub - reliable free source for EPS estimates
        const fetchFinnhub = async () => {
          try {
            const res = await fetch(`https://finnhub.io/api/v1/stock/earnings?symbol=${symbol}&token=${FINNHUB_KEY}`);
            if (!res.ok) return { source: 'finnhub', error: `HTTP ${res.status}`, timestamp: Date.now() };
            const data = await res.json();
            if (!Array.isArray(data)) return { source: 'finnhub', error: 'Invalid response', timestamp: Date.now() };
            return { source: 'finnhub', data, timestamp: Date.now() };
          } catch (e) {
            return { source: 'finnhub', error: e.message, timestamp: Date.now() };
          }
        };

        // Finnhub revenue estimates
        const fetchFinnhubRevenue = async () => {
          try {
            const res = await fetch(`https://finnhub.io/api/v1/stock/revenue-estimate?symbol=${symbol}&freq=quarterly&token=${FINNHUB_KEY}`);
            if (!res.ok) return { source: 'finnhub-revenue', error: `HTTP ${res.status}`, timestamp: Date.now() };
            const data = await res.json();
            return { source: 'finnhub-revenue', data, timestamp: Date.now() };
          } catch (e) {
            return { source: 'finnhub-revenue', error: e.message, timestamp: Date.now() };
          }
        };

        // Build source array - Finnhub is primary for EPS estimates
        // Note: Finnhub revenue-estimate requires paid subscription, so we skip it
        const sources = [
          fetchFinnhub(),
          fetchEdgar(),
          fetchFmpSurprises()
        ];

        // Only add AlphaVantage if key is configured (as backup)
        if (ALPHAVANTAGE_KEY) {
          sources.push(fetchAlphaVantage());
        }

        if (mode === 'race') {
          // Return first successful result
          try {
            const results = await Promise.all(sources);
            const successful = results.filter(r => !r.error && r.data);

            if (successful.length === 0) {
              return new Response(JSON.stringify({
                error: 'All sources failed',
                details: results.map(r => ({ source: r.source, error: r.error }))
              }), {
                status: 500,
                headers: { ...corsHeaders, 'Content-Type': 'application/json' }
              });
            }

            // Get first result
            const first = successful[0];
            const normalized = normalizeEarningsData(first);

            // Store merged results in background if we have EARNINGS_STORE
            if (env.EARNINGS_STORE && successful.length > 1) {
              ctx.waitUntil((async () => {
                const merged = mergeEarningsResults(successful);
                if (merged.data.quarter) {
                  const key = `earnings:${symbol}:${merged.data.quarter}`;
                  const record = {
                    ticker: symbol,
                    ...merged.data,
                    confidence: merged.confidence,
                    discrepancies: merged.discrepancies,
                    lastUpdated: new Date().toISOString()
                  };
                  await env.EARNINGS_STORE.put(key, JSON.stringify(record), {
                    expirationTtl: 60 * 60 * 24 * 365
                  });
                  // Update latest pointer
                  await env.EARNINGS_STORE.put(`earnings:${symbol}:latest`, key);
                  // Update history index
                  const historyKey = `earnings:${symbol}:history`;
                  const history = await env.EARNINGS_STORE.get(historyKey, { type: 'json' }) || [];
                  if (!history.includes(merged.data.quarter)) {
                    history.unshift(merged.data.quarter);
                    await env.EARNINGS_STORE.put(historyKey, JSON.stringify(history.slice(0, 20)));
                  }
                }
              })());
            }

            return new Response(JSON.stringify({
              mode: 'race',
              winner: first.source,
              data: normalized,
              confidence: 'single',
              pendingSources: results.filter(r => r.source !== first.source).map(r => r.source),
              allResults: successful.length
            }), {
              headers: { ...corsHeaders, 'Content-Type': 'application/json' }
            });

          } catch (error) {
            return new Response(JSON.stringify({ error: error.message }), {
              status: 500,
              headers: { ...corsHeaders, 'Content-Type': 'application/json' }
            });
          }

        } else {
          // Merge mode: wait for all and cross-validate
          const results = await Promise.all(sources);
          const successful = results.filter(r => !r.error && r.data);

          if (successful.length === 0) {
            return new Response(JSON.stringify({
              error: 'All sources failed',
              details: results.map(r => ({ source: r.source, error: r.error }))
            }), {
              status: 500,
              headers: { ...corsHeaders, 'Content-Type': 'application/json' }
            });
          }

          const merged = mergeEarningsResults(successful);

          // Store in KV if available
          if (env.EARNINGS_STORE && merged.data.quarter) {
            const key = `earnings:${symbol}:${merged.data.quarter}`;
            const record = {
              ticker: symbol,
              ...merged.data,
              confidence: merged.confidence,
              discrepancies: merged.discrepancies,
              lastUpdated: new Date().toISOString()
            };
            await env.EARNINGS_STORE.put(key, JSON.stringify(record), {
              expirationTtl: 60 * 60 * 24 * 365
            });
            // Update latest pointer
            await env.EARNINGS_STORE.put(`earnings:${symbol}:latest`, key);
            // Update history index
            const historyKey = `earnings:${symbol}:history`;
            const history = await env.EARNINGS_STORE.get(historyKey, { type: 'json' }) || [];
            if (!history.includes(merged.data.quarter)) {
              history.unshift(merged.data.quarter);
              await env.EARNINGS_STORE.put(historyKey, JSON.stringify(history.slice(0, 20)));
            }
          }

          return new Response(JSON.stringify({
            mode: 'merge',
            sources: successful.map(s => s.source),
            failed: results.filter(r => r.error).map(r => ({ source: r.source, error: r.error })),
            data: merged.data,
            confidence: merged.confidence,
            discrepancies: merged.discrepancies
          }), {
            headers: { ...corsHeaders, 'Content-Type': 'application/json' }
          });
        }
      }

      // GET /earnings/stored/:symbol/:quarter? - Retrieve from KV
      if (path.startsWith('/earnings/stored/')) {
        const parts = path.split('/').filter(p => p);
        const symbol = parts[2];
        const quarter = parts[3]; // Optional, e.g., "2025-Q4"

        if (!env.EARNINGS_STORE) {
          return new Response(JSON.stringify({ error: 'EARNINGS_STORE KV not configured' }), {
            status: 500,
            headers: { ...corsHeaders, 'Content-Type': 'application/json' }
          });
        }

        if (quarter) {
          // Get specific quarter
          const key = `earnings:${symbol}:${quarter}`;
          const data = await env.EARNINGS_STORE.get(key, { type: 'json' });

          if (!data) {
            return new Response(JSON.stringify({ error: 'Quarter not found', quarter }), {
              status: 404,
              headers: { ...corsHeaders, 'Content-Type': 'application/json' }
            });
          }

          return new Response(JSON.stringify(data), {
            headers: { ...corsHeaders, 'Content-Type': 'application/json' }
          });

        } else {
          // Get latest + history index
          const latestKey = await env.EARNINGS_STORE.get(`earnings:${symbol}:latest`);
          const historyKey = `earnings:${symbol}:history`;
          const history = await env.EARNINGS_STORE.get(historyKey, { type: 'json' }) || [];

          let latest = null;
          if (latestKey) {
            latest = await env.EARNINGS_STORE.get(latestKey, { type: 'json' });
          }

          return new Response(JSON.stringify({
            latest,
            availableQuarters: history
          }), {
            headers: { ...corsHeaders, 'Content-Type': 'application/json' }
          });
        }
      }

      // ============================================================
      // YAHOO ROUTES
      // ============================================================

      // GET /yahoo-quote/:symbol - Extended hours prices
      if (path.startsWith('/yahoo-quote/')) {
        const symbol = path.split('/')[2];
        targetUrl = `https://query1.finance.yahoo.com/v6/finance/quote?symbols=${symbol}`;

        const response = await fetch(targetUrl, { headers: yahooHeaders });
        return new Response(response.body, {
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }

      // GET /yahoo/:symbol - Chart data
      if (path.startsWith('/yahoo/')) {
        const symbol = path.split('/')[2];
        const interval = url.searchParams.get('interval') || '1d';
        const range = url.searchParams.get('range') || '1d';
        const includePrePost = url.searchParams.get('includePrePost') || 'false';

        targetUrl = `https://query1.finance.yahoo.com/v8/finance/chart/${symbol}?interval=${interval}&range=${range}&includePrePost=${includePrePost}`;

        const shouldCache = range !== '1d';

        if (shouldCache) {
          const cache = caches.default;
          let response = await cache.match(request);

          if (!response) {
            response = await fetch(targetUrl, { headers: yahooHeaders });

            if (response.ok) {
              response = new Response(response.body, {
                headers: { ...corsHeaders, 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=300' },
              });
              ctx.waitUntil(cache.put(request, response.clone()));
            }
          }
          return new Response(response.body, {
            headers: { ...corsHeaders, 'Content-Type': 'application/json' },
          });
        } else {
          const response = await fetch(targetUrl, { headers: yahooHeaders });
          return new Response(response.body, {
            headers: { ...corsHeaders, 'Content-Type': 'application/json' },
          });
        }
      }

      // ============================================================
      // ALPACA ROUTES
      // ============================================================

      // GET /trades/:symbol - Latest trade
      if (path.startsWith('/trades/')) {
        const symbol = path.split('/').filter(p => p)[1];
        const feed = url.searchParams.get('feed') || 'sip';
        targetUrl = `https://data.alpaca.markets/v2/stocks/${symbol}/trades/latest?feed=${feed}`;

        const response = await fetch(targetUrl, { headers: alpacaHeaders });
        return new Response(response.body, {
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }

      // GET /bars/:symbol - Historical bars
      if (path.startsWith('/bars/')) {
        const symbol = path.split('/').filter(p => p)[1];
        targetUrl = `https://data.alpaca.markets/v2/stocks/${symbol}/bars${url.search}`;

        const response = await fetch(targetUrl, { headers: alpacaHeaders });
        return new Response(response.body, {
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }

      // GET /clock - Market status
      if (path === '/clock' || path === '/clock/') {
        targetUrl = 'https://paper-api.alpaca.markets/v2/clock';

        const response = await fetch(targetUrl, { headers: alpacaHeaders });
        return new Response(response.body, {
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }

      // ============================================================
      // EXCHANGE RATE - USD to GBP
      // ============================================================

      // GET /exchange-rate - USD to GBP exchange rate
      if (path === '/exchange-rate' || path === '/exchange-rate/') {
        const cache = caches.default;
        const cacheKey = new Request('https://exchange-rate-cache/usd-gbp', request);
        let response = await cache.match(cacheKey);

        if (!response) {
          const fxRes = await fetch('https://api.frankfurter.app/latest?from=USD&to=GBP');

          if (fxRes.ok) {
            const fxData = await fxRes.json();
            const rate = fxData.rates?.GBP;

            response = new Response(JSON.stringify({
              rate: rate,
              base: 'USD',
              target: 'GBP',
              timestamp: new Date().toISOString()
            }), {
              headers: {
                ...corsHeaders,
                'Content-Type': 'application/json',
                'Cache-Control': 'public, max-age=3600'
              }
            });
            ctx.waitUntil(cache.put(cacheKey, response.clone()));
          } else {
            return new Response(JSON.stringify({ error: 'Exchange rate fetch failed' }), {
              status: 500,
              headers: { ...corsHeaders, 'Content-Type': 'application/json' }
            });
          }
        }
        return response;
      }

      // ============================================================
      // 404 - Not Found
      // ============================================================

      return new Response(JSON.stringify({ error: 'Invalid endpoint' }), {
        status: 404,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });

    } catch (error) {
      return new Response(JSON.stringify({ error: error.message }), {
        status: 500,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }
  },

  // ============================================================
  // SCHEDULED HANDLER - Cron trigger for automatic collection
  // ============================================================
  async scheduled(event, env, ctx) {
    console.log('Scheduled news collection triggered at:', new Date().toISOString());

    ctx.waitUntil(
      runNewsCollection(env)
        .then(result => console.log('Scheduled collection complete:', JSON.stringify(result)))
        .catch(error => console.error('Scheduled collection error:', error))
    );
  },
};