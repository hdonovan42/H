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