/**
 * Free Google News RSS Fetcher & Headline Parser for Stock Market Sentiment
 */

export const getStockNews = async (symbol) => {
  try {
    const cleanSym = (symbol || 'NIFTY')
      .replace(/\s+(LTD|LIMITED|CORP|INC)$/gi, '')
      .trim();

    const query = encodeURIComponent(`${cleanSym} stock news India`);
    const url = `https://news.google.com/rss/search?q=${query}&hl=en-IN&gl=IN&ceid=IN:en`;

    const res = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      },
    });

    if (!res.ok) return [];

    const xml = await res.text();

    // Zero-dependency XML Regex Extraction for RSS <item> tags
    const items = [];
    const itemRegex = /<item>[\s\S]*?<title>(.*?)<\/title>[\s\S]*?<pubDate>(.*?)<\/pubDate>[\s\S]*?<\/item>/gi;
    let match;

    while ((match = itemRegex.exec(xml)) !== null && items.length < 100) {
      let title = match[1] || '';
      // Clean HTML entities (e.g. &amp;, &quot;, &#39;)
      title = title
        .replace(/<!\[CDATA\[(.*?)\]\]>/g, '$1')
        .replace(/&amp;/g, '&')
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .trim();

      const pubDate = match[2] ? new Date(match[2]).toISOString() : new Date().toISOString();

      if (title) {
        items.push({ title, pubDate });
      }
    }

    console.log(`✅ Loaded ${items.length} Google News headlines for ${cleanSym}`);
    return items;
  } catch (err) {
    console.warn(`⚠️ Google News fetch failed for ${symbol}:`, err.message);
    return [];
  }
};
