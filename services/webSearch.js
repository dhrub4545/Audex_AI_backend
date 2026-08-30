const axios = require('axios');

/**
 * Performs a resilient web search query using Yahoo search with DuckDuckGo fallback
 * to ground the AI chat assistant with live web context.
 * @param {string} query 
 * @returns {Promise<Array<{title: string, url: string, snippet: string}>>}
 */
async function searchWeb(query) {
  if (!query || typeof query !== 'string' || !query.trim()) {
    return [];
  }

  const cleanQuery = query.trim();

  // 1. Primary: Yahoo Web Search HTML extraction
  try {
    const url = `https://search.yahoo.com/search?q=${encodeURIComponent(cleanQuery)}`;
    const response = await axios.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.5'
      },
      timeout: 8000
    });

    const html = response.data;
    const results = [];
    
    // Find all links to r.search.yahoo.com
    const linkRegex = /<a[^>]*href="([^"]+r\.search\.yahoo\.com[^"]*\/RU=([^"\/]+)[^"]*)"[^>]*>([\s\S]*?)<\/a>/g;
    let match;
    
    while ((match = linkRegex.exec(html)) !== null && results.length < 5) {
      const rawUrl = match[1];
      const innerHtml = match[3];
      
      const ruParts = rawUrl.split('/RU=');
      if (ruParts.length <= 1) continue;
      const targetUrl = decodeURIComponent(ruParts[1].split('/')[0]);
      
      if (targetUrl.includes('yahoo.com') || targetUrl.includes('yahoo.co') || targetUrl.includes('yimg.com')) continue;
      
      let title = innerHtml.replace(/<[^>]*>/g, '').trim();
      title = title.replace(/^[a-zA-Z0-9.-]+\.[a-zA-Z]{2,6}[\s\S]*?›[\s\S]*?(?=[A-Z])/g, '').trim();
      if (title.includes('›')) {
        const parts = title.split('›');
        title = parts[parts.length - 1].trim();
      }
      
      const startIndex = linkRegex.lastIndex;
      const nextHtml = html.substring(startIndex, startIndex + 1500);
      const snippetMatch = nextHtml.match(/<div class="compText aAbs">([\s\S]*?)<\/div>/);
      let snippet = '';
      if (snippetMatch) {
        snippet = snippetMatch[1].replace(/<[^>]*>/g, '').trim();
      } else {
        const pMatch = nextHtml.match(/<p class="[^"]*fc-dustygray[^"]*">([\s\S]*?)<\/p>/);
        if (pMatch) {
          snippet = pMatch[1].replace(/<[^>]*>/g, '').trim();
        }
      }
      
      if (!results.some(r => r.url === targetUrl)) {
        results.push({
          title: title || "Web Search Result",
          url: targetUrl,
          snippet: snippet || "No description snippet available."
        });
      }
    }
    
    if (results.length > 0) {
      return results;
    }
  } catch (error) {
    console.warn('Yahoo Search warning:', error.message);
  }

  // 2. Fallback: DuckDuckGo HTML Instant Search
  try {
    const ddgUrl = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(cleanQuery)}`;
    const ddgRes = await axios.get(ddgUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
      },
      timeout: 8000
    });

    const ddgHtml = ddgRes.data;
    const ddgResults = [];
    const resultRegex = /<a class="result__snippet[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g;
    let ddgMatch;
    while ((ddgMatch = resultRegex.exec(ddgHtml)) !== null && ddgResults.length < 4) {
      const targetUrl = ddgMatch[1];
      const snippet = ddgMatch[2].replace(/<[^>]*>/g, '').trim();
      ddgResults.push({
        title: "Search Grounding Result",
        url: targetUrl,
        snippet: snippet || "Grounded documentation result."
      });
    }

    if (ddgResults.length > 0) {
      return ddgResults;
    }
  } catch (ddgErr) {
    console.warn('DuckDuckGo Search warning:', ddgErr.message);
  }

  return [];
}

module.exports = { searchWeb };
