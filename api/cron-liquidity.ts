import { VercelRequest, VercelResponse } from '@vercel/node';
import { createClient } from '@supabase/supabase-js';

export default async function handler(req: VercelRequest, res: VercelResponse) {
    try {
        const SUPABASE_URL = process.env.SUPABASE_URL || '';
        const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || '';

        if (!SUPABASE_URL.startsWith('http') || SUPABASE_SERVICE_ROLE_KEY.length < 10) {
            return res.status(500).json({ success: false, error: "Missing DB configuration." });
        }

        const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });

        // 1. Fetch deep trending data via GeckoTerminal API
        const response = await fetch('https://api.geckoterminal.com/api/v2/networks/solana/trending_pools');
        const json = await response.json();
        
        if (!json.data) throw new Error("GeckoTerminal API failure");

        // 2. Parse the Top 5 pools for deep analytics
        const pools = json.data.slice(0, 5).map((p: any) => p.attributes);

        let totalVol = 0;
        let totalLiq = 0;
        let totalBuys = 0;
        let totalSells = 0;
        let tokenRows = '';

        pools.forEach((pool: any, index: number) => {
            // Extract raw data points
            const vol24 = parseFloat(pool.volume_usd?.h24 || '0');
            const liq = parseFloat(pool.reserve_in_usd || '0');
            const buys = pool.transactions?.h24?.buys || 0;
            const sells = pool.transactions?.h24?.sells || 0;
            const price = parseFloat(pool.base_token_price_usd || '0');
            const change24 = parseFloat(pool.price_change_percentage?.h24 || '0');
            const fdv = parseFloat(pool.fdv_usd || '0');
            
            // Add to macro sector totals
            totalVol += vol24;
            totalLiq += liq;
            totalBuys += buys;
            totalSells += sells;

            // Compute Intelligence Vectors
            const trendStr = change24 >= 0 ? '🟢' : '🔴';
            const signStr = change24 >= 0 ? '+' : '';
            
            // Velocity: How many times is the liquidity pool turning over per day?
            const volLiqRatio = liq > 0 ? (vol24 / liq).toFixed(2) : '0';
            
            // Pressure: Are there more individual buyers or sellers?
            const buySellRatio = sells > 0 ? (buys / sells).toFixed(2) : '0';

            tokenRows += `
${index + 1}. <b>${pool.name}</b>
  ┣ <b>Price:</b> $${price.toFixed(6)} (${trendStr} ${signStr}${change24.toFixed(2)}%)
  ┣ <b>Pool Contract:</b> <code>${pool.address}</code>
  ┣ <b>Volume (24h):</b> $${(vol24 / 1000000).toFixed(2)}M
  ┣ <b>Liquidity:</b> $${(liq / 1000000).toFixed(2)}M
  ┣ <b>Capital Velocity (Vol/Liq):</b> ${volLiqRatio}x
  ┣ <b>Order Pressure:</b> ${buySellRatio} (Buys/Sells)
  ┗ <b>FDV Valuation:</b> $${(fdv / 1000000).toFixed(2)}M
`;
        });

        // Calculate macro sector sentiment
        const overallPressure = totalSells > 0 ? (totalBuys / totalSells).toFixed(2) : '0';

        // 3. Compile the Intelligence Matrix
        const reportContent = `<pre>
🧠 APEX ON-CHAIN LIQUIDITY INTELLIGENCE
════════════════════════════════════
GLOBAL SECTOR HEAT (TOP 5 TRENDING)
• Aggregated Volume: $${(totalVol / 1000000).toFixed(2)}M
• Pooled Liquidity: $${(totalLiq / 1000000).toFixed(2)}M
• Sector Order Pressure: ${overallPressure} Buy/Sell Ratio
───────────────────────────────────</pre>${tokenRows}
<pre>───────────────────────────────────
Intelligence compiled via GeckoTerminal API.
Audit: ${new Date().toISOString().replace('T', ' ').substring(0, 19)} UTC</pre>`;

        // 4. Overwrite Database Cache
        const { error } = await supabase.from('system_reports').insert({
            report_type: 'liquidity',
            content: reportContent
        });

        if (error) throw error;

        return res.status(200).json({ success: true, message: "Deep intelligence liquidity compiled." });

    } catch (error: any) {
        console.error("Cron Error:", error);
        return res.status(500).json({ success: false, error: error.message });
    }
}