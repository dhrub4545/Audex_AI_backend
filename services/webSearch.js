const axios = require('axios');

/**
 * Performs a web search query using Yahoo search (to avoid bot protection/captchas)
 * and parses the top 4-5 results.
 * @param {string} query 
 * @returns {Promise<Array<{title: string, url: string, snippet: string}>>}
 */
async function searchWeb(query) {
  try {
    const url = `https://search.yahoo.com/search?q=${encodeURIComponent(query)}`;
    const response = await axios.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.5'
      },
      timeout: 10000 // 10 second timeout
    });

    const html = response.data;
    const results = [];
    
    // Find all links to r.search.yahoo.com
    const linkRegex = /<a[^>]*href="([^"]+r\.search\.yahoo\.com[^"]*\/RU=([^"\/]+)[^"]*)"[^>]*>([\s\S]*?)<\/a>/g;
    let match;
    
    while ((match = linkRegex.exec(html)) !== null && results.length < 5) {
      const rawUrl = match[1];
      const innerHtml = match[3];
      
      // Extract target URL
      const ruParts = rawUrl.split('/RU=');
      if (ruParts.length <= 1) continue;
      const targetUrl = decodeURIComponent(ruParts[1].split('/')[0]);
      
      // Skip internal Yahoo links
      if (targetUrl.includes('yahoo.com') || targetUrl.includes('yahoo.co') || targetUrl.includes('yimg.com')) continue;
      
      // Clean up title (remove trailing/leading tags and yahoo path prefixes)
      let title = innerHtml.replace(/<[^>]*>/g, '').trim();
      title = title.replace(/^[a-zA-Z0-9.-]+\.[a-zA-Z]{2,6}[\s\S]*?›[\s\S]*?(?=[A-Z])/g, '').trim();
      if (title.includes('›')) {
        const parts = title.split('›');
        title = parts[parts.length - 1].trim();
      }
      
      // Find snippet: search forward in the HTML from the current index for the compText class
      const startIndex = linkRegex.lastIndex;
      const nextHtml = html.substring(startIndex, startIndex + 1500);
      const snippetMatch = nextHtml.match(/<div class="compText aAbs">([\s\S]*?)<\/div>/);
      let snippet = '';
      if (snippetMatch) {
        snippet = snippetMatch[1].replace(/<[^>]*>/g, '').trim();
      } else {
        // Fallback: try to match any paragraph that looks like a description
        const pMatch = nextHtml.match(/<p class="[^"]*fc-dustygray[^"]*">([\s\S]*?)<\/p>/);
        if (pMatch) {
          snippet = pMatch[1].replace(/<[^>]*>/g, '').trim();
        }
      }
      
      // Avoid duplicates
      if (!results.some(r => r.url === targetUrl)) {
        results.push({
          title: title || "Web Search Result",
          url: targetUrl,
          snippet: snippet || "No description snippet available."
        });
      }
    }
    
    return results;
  } catch (error) {
    console.error('Web Search Service Error:', error.message);
    return [];
  }
}

module.exports = { searchWeb };
