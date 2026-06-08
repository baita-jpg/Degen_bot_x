// api/cron-liquidity.ts
import { VercelRequest, VercelResponse } from '@vercel/node';
import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = process.env.SUPABASE_URL || '';
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });

export default async function handler(req: VercelRequest, res: VercelResponse) {
    try {
        // 1. Fetch live top Solana pairs directly from DexScreener's search engine
        const response = await fetch('https://api.dexscreener.com/latest/dex/search?q=solana');
        const json = await response.json();
        
        if (!json.pairs) throw new Error("DexScreener API routing failure");

        // 2. Filter, parse, and sort the highest volume tokens
        const solanaPairs = json.pairs
            .filter((p: any) => p.chainId === 'solana' && p.liquidity && p.volume)
            .sort((a: any, b: any) => b.volume.h24 - a.volume.h24)
            .slice(0, 5); // Target the Top 5 market movers

        let totalLiq = 0;
        let totalVol = 0;
        let pairRows = '';

        solanaPairs.forEach((pair: any, index: number) => {
            totalLiq += pair.liquidity.usd;
            totalVol += pair.volume.h24;
            
            const trend = pair.priceChange.h24 >= 0 ? '🟢' : '🔴';
            pairRows += `\n${index + 1}. <b>$${pair.baseToken.symbol}</b> ──▶ <code>$${(pair.volume.h24 / 1000000).toFixed(2)}M</code> Vol\n`;
            pairRows += `   └ Liq: $${(pair.liquidity.usd / 1000000).toFixed(2)}M | 24h: ${trend} ${pair.priceChange.h24}%\n`;
        });

        // 3. Compile the final HTML intelligence report layout
        const reportContent = `
💧 <b>NETWORK LIQUIDITY & VOLUME REPORT</b>
════════════════════════════════════
<b>Global Solana Top Pair Snapshot:</b>
• <b>Aggregated 24h Volume:</b> <code>$${(totalVol / 1000000).toFixed(2)}M</code>
• <b>Active Usable Liquidity:</b> <code>$${(totalLiq / 1000000).toFixed(2)}M</code>

🔥 <b>HIGHEST VELOCITY TOKENS (24H):</b>${pairRows}
───────────────────────────────────
<i>Data aggregated via DexScreener indexing nodes.</i>
<i>Last Synchronized: ${new Date().toISOString().replace('T', ' ').substring(0, 19)} UTC</i>
`;

        // 4. Overwrite the database cache with the fresh intelligence
        const { error } = await supabase.from('system_reports').insert({
            report_type: 'liquidity',
            content: reportContent
        });

        if (error) throw error;

        return res.status(200).json({ success: true, message: "Liquidity index compiled successfully." });

    } catch (error: any) {
        console.error("Cron Execution Error:", error);
        return res.status(500).json({ success: false, error: error.message });
    }
}