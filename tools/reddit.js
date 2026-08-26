/**
 * Free Reddit Post & Sentiment Scraper for Indian Stock Market Communities
 */

export const getRedditSentiment = async (symbol) => {
  try {
    const cleanSym = (symbol || 'NIFTY')
      .replace(/\s+(LTD|LIMITED|CORP|INC)$/gi, '')
      .trim();

    const query = encodeURIComponent(cleanSym);
    const url = `https://www.reddit.com/r/IndianStreetBets/search.json?q=${query}&sort=new&limit=10`;

    const res = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) TradingAgent/1.0',
      },
    });

    if (!res.ok) return [];

    const data = await res.json();
    if (!data || !data.data || !data.data.children) return [];

    const posts = data.data.children.map(child => ({
      title: child.data.title,
      ups: child.data.ups,
      num_comments: child.data.num_comments,
      permalink: `https://reddit.com${child.data.permalink}`,
      created: new Date(child.data.created_utc * 1000).toISOString(),
    })).slice(0, 6);

    console.log(`✅ Loaded ${posts.length} Reddit discussions for ${cleanSym}`);
    return posts;
  } catch (err) {
    console.warn(`⚠️ Reddit fetch failed for ${symbol}:`, err.message);
    return [];
  }
};
