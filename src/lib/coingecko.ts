const COINGECKO_API_URL = "https://api.coingecko.com/api/v3";
const CACHE = new Map();

export async function getSimplePrice(
  id: string,
  vsCurrencies: string
): Promise<{ [key: string]: { [key: string]: number } }> {
  const url = `${COINGECKO_API_URL}/simple/price?ids=${id}&vs_currencies=${vsCurrencies}`;
  const now = Date.now();

  if (CACHE.has(url)) {
    const cached = CACHE.get(url);
    if (cached && cached.expires > now) {
      return cached.data;
    }
  }

  const response = await fetch(url);

  if (!response.ok) {
    throw new Error(`Failed to fetch ${url}`);
  }

  const data = await response.json();
  const expires = now + 1000 * 60 * 5; // 5 minutes

  CACHE.set(url, { data, expires });

  return data;
}
