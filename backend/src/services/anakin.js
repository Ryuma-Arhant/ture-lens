import axios from 'axios'
import { callLLM, parseJSON } from './llm.js'

const BASE = 'https://api.anakin.io/v1'

// ─── 3-key round-robin rotation ──────────────────────────────────────────────
const KEYS = [
  process.env.ANAKIN_API_KEY_1,
  process.env.ANAKIN_API_KEY_2,
  process.env.ANAKIN_API_KEY_3,
].filter(Boolean)

if (KEYS.length === 0) KEYS.push(process.env.ANAKIN_API_KEY)

let keyIdx = 0
function nextKey() {
  const key = KEYS[keyIdx % KEYS.length]
  keyIdx++
  return key
}

const h = (key) => ({
  'X-API-Key': key,
  'Content-Type': 'application/json',
})

// ─── Supported e-commerce platforms ─────────────────────────────────────────
const ALL_PLATFORMS = [
  { site: 'flipkart.com',      name: 'Flipkart' },
  { site: 'amazon.in',         name: 'Amazon' },
  { site: 'myntra.com',        name: 'Myntra' },
  { site: 'meesho.com',        name: 'Meesho' },
  { site: 'croma.com',         name: 'Croma' },
  { site: 'tatacliq.com',      name: 'Tata CLiQ' },
  { site: 'ajio.com',          name: 'AJIO' },
  { site: 'reliancedigital.in',name: 'Reliance Digital' },
]

// ─── Poll async scrape job ────────────────────────────────────────────────────
async function pollJob(jobId, key, timeoutMs = 28000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    await new Promise(r => setTimeout(r, 2500))
    const { data } = await axios.get(
      `${BASE}/url-scraper/${jobId}`,
      { headers: h(key), timeout: 10000 }
    )
    if (data.status === 'completed') return data
    if (data.status === 'failed') throw new Error(`Scrape failed: ${data.error ?? JSON.stringify(data)}`)
  }
  throw new Error(`Scrape job ${jobId} timed out`)
}

// ─── WORKFLOW 1: Scrape a product page → structured JSON ─────────────────────
export async function scrapeProduct(url) {
  const key = nextKey()
  if (!key) throw new Error('No ANAKIN_API_KEY_1/2/3 set')

  const { data: job } = await axios.post(
    `${BASE}/url-scraper`,
    { url, useBrowser: true, country: 'in' },
    { headers: h(key), timeout: 12000 }
  )

  const jobId = job.jobId ?? job.id
  if (!jobId) throw new Error(`No jobId returned: ${JSON.stringify(job)}`)

  const result = await pollJob(jobId, key)

  const rawContent = result.markdown ?? result.content ?? result.text ?? result.html ?? ''
  if (!rawContent.trim()) throw new Error('Scrape returned empty content')

  return extractProductData(rawContent)
}

// ─── WORKFLOW 2: Find same product on specific platforms ─────────────────────
// Does one targeted search per platform → extracts direct product page URL
// Returns array of { site, url, title, priceFromSearch, similarity_score }
export async function findProductOnPlatforms(productTitle, brand, sourceUrl, maxPlatforms = 3) {
  const key = nextKey()
  if (!key) throw new Error('No ANAKIN_API_KEY_1/2/3 set')

  // Exclude the source platform from search targets
  const sourceHost = (() => {
    try { return new URL(sourceUrl).hostname.replace('www.', '') } catch { return '' }
  })()
  const targets = ALL_PLATFORMS
    .filter(p => !sourceHost.includes(p.site.split('.')[0]))
    .slice(0, maxPlatforms)

  // Run all platform searches in parallel (each uses a rotated key)
  const searchResults = await Promise.allSettled(
    targets.map(platform => searchOnPlatform(productTitle, brand, platform))
  )

  return searchResults
    .map((r, i) => r.status === 'fulfilled' && r.value ? { ...r.value, platform: targets[i] } : null)
    .filter(Boolean)
    .filter(r => r.similarity_score >= 0.35) // product must be plausibly same item
}

// Search for a product on one specific platform
async function searchOnPlatform(productTitle, brand, platform) {
  const key = nextKey()
  // Clean title: remove overly long spec strings for better matching
  const shortTitle = productTitle.split(/[,|–—]/)[0].trim().slice(0, 80)
  const query = `"${shortTitle}" ${brand} buy online site:${platform.site}`

  try {
    const { data } = await axios.post(
      `${BASE}/search`,
      { query, country: 'in' },
      { headers: h(key), timeout: 12000 }
    )

    const results = data?.results ?? data?.citations ?? data?.items ?? []

    // Find first result URL that is actually from this platform (not a cached/proxied URL)
    const match = results.find(r => {
      const url = r.url ?? r.link ?? ''
      return url.includes(platform.site.split('.')[0]) || url.includes(platform.site)
    })

    if (!match) return null

    const url = match.url ?? match.link
    const title = match.title ?? ''
    const snippet = match.snippet ?? match.description ?? match.content ?? ''

    // Extract price from snippet
    const priceMatch = `${title} ${snippet}`.match(/(?:₹|rs\.?|inr)\s*([\d,]+(?:\.\d{1,2})?)/i)
    const priceFromSearch = priceMatch ? parseFloat(priceMatch[1].replace(/,/g, '')) : null

    return {
      site: platform.name,
      url,
      title,
      snippet,
      priceFromSearch,
      similarity_score: jaccardSimilarity(productTitle, title),
    }
  } catch {
    return null
  }
}

// ─── Legacy single-search competitor finder (used by /api/audit) ─────────────
export async function findCompetitors(productTitle, brand, keySpecs) {
  const key = nextKey()
  if (!key) throw new Error('No ANAKIN_API_KEY_1/2/3 set')

  const specsStr = keySpecs && typeof keySpecs === 'object'
    ? Object.values(keySpecs).slice(0, 3).join(' ')
    : ''
  const query = `${productTitle} ${brand} ${specsStr} price buy india`.trim()

  const { data } = await axios.post(
    `${BASE}/search`,
    { query, country: 'in' },
    { headers: h(key), timeout: 15000 }
  )

  return parseSearchResults(data, productTitle)
}

// ─── LLM Extraction: raw scraped markdown → structured product JSON ────────────
async function extractProductData(rawContent) {
  const today = new Date().toISOString().slice(0, 10)
  const prompt = `Extract product data from this scraped e-commerce page. Return ONLY valid JSON, no markdown fences.

Schema (null for missing fields):
{"title":"string","brand":"string","price_current":number,"price_mrp":number|null,"currency":"INR"|"USD"|"GBP","images":["url"],"rating_avg":number|null,"rating_count":number|null,"reviews":[{"text":"string","rating":number,"timestamp":"ISO8601|null","reviewer_name":"string"}],"seller":{"name":"string","age_days":number|null,"rating":number|null,"total_reviews":number|null},"return_policy_text":"string","delivery_estimate":"string","specifications":{},"source_site":"amazon.in|flipkart.com|myntra.com|ebay.com|other"}

Rules:
- price_current = current selling price (number only)
- price_mrp = crossed-out/MRP price
- Max 20 reviews, most recent first
- seller.age_days: days from join date to today (${today}), null if unknown
- Extract real product image URLs if visible in content

SCRAPED CONTENT:
${rawContent.slice(0, 8000)}`

  const raw = await callLLM(prompt, 2000)
  return parseJSON(raw)
}

// ─── Parse generic search results → competitor price list ────────────────────
function parseSearchResults(data, productTitle) {
  const results = data?.results ?? data?.citations ?? data?.items ?? []
  const PRICE_RE = /(?:₹|rs\.?|inr|usd|\$)\s*([\d,]+(?:\.\d{1,2})?)/gi

  const matches = []
  for (const r of results.slice(0, 8)) {
    const siteUrl = r.url ?? r.link ?? ''
    const site = extractSiteName(siteUrl)
    if (!site) continue

    const text = `${r.title ?? ''} ${r.snippet ?? r.content ?? r.description ?? ''}`
    const priceMatches = [...text.matchAll(PRICE_RE)]
    if (!priceMatches.length) continue

    const price = parseFloat(priceMatches[0][1].replace(/,/g, ''))
    if (!price || price < 10) continue

    matches.push({
      site,
      url: siteUrl,
      title: r.title ?? '',
      price,
      rating: null,
      similarity_score: jaccardSimilarity(productTitle, r.title ?? ''),
    })
  }

  return {
    matches: matches
      .filter(m => m.similarity_score >= 0.55)
      .sort((a, b) => b.similarity_score - a.similarity_score)
      .slice(0, 3),
  }
}

function extractSiteName(url) {
  try {
    const host = new URL(url).hostname.replace('www.', '')
    return ALL_PLATFORMS.find(p => host.includes(p.site.split('.')[0]))?.name ?? host
  } catch { return null }
}

function jaccardSimilarity(a, b) {
  if (!a || !b) return 0
  const wa = new Set(a.toLowerCase().split(/\W+/).filter(w => w.length > 2))
  const wb = new Set(b.toLowerCase().split(/\W+/).filter(w => w.length > 2))
  const inter = [...wa].filter(w => wb.has(w)).length
  const union = new Set([...wa, ...wb]).size
  return union === 0 ? 0 : inter / union
}
