// api/webhook-interceptor.ts
import { VercelRequest, VercelResponse } from '@vercel/node';
import { createClient } from '@supabase/supabase-js';
import { runCryptographicAudit } from '../utils/tokenValidator';

// Raydium V4 AMM Program ID
const RAYDIUM_V4_PROGRAM_ID = '675kPX9M4SG3G2j68YBtE7QjkBf5qvFMcM6YgG9EbyR';

export default async function handler(req: VercelRequest, res: VercelResponse) {
    // Only accept POST requests from our Webhook provider
    if (req.method !== 'POST') return res.status(405).send('Method Not Allowed');

    try {
        const payload = req.body;
        // Verify this is an array of transactions (standard Helius Webhook format)
        if (!Array.isArray(payload) || payload.length === 0) {
            return res.status(200).send('Empty or invalid payload');
        }

        const SUPABASE_URL = process.env.SUPABASE_URL || '';
        const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
        const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

        for (const tx of payload) {
            // Check if the transaction interacted with Raydium
            const involvesRaydium = tx.accountData.some((acc: any) => acc.account === RAYDIUM_V4_PROGRAM_ID);
            if (!involvesRaydium) continue;

            // Extract the newly created token mint (simplified extraction logic)
            // In a live Helius payload, tokenTransfers or instructions array contains the base mint
            const tokenTransfers = tx.tokenTransfers || [];
            if (tokenTransfers.length === 0) continue;

            // Grab the primary token address (ignoring Wrapped SOL)
            const baseMint = tokenTransfers.find((t: any) => t.mint !== 'So11111111111111111111111111111111111111112')?.mint;
            if (!baseMint) continue;

            // 1. RUN THE CRYPTOGRAPHIC AUDIT
            const auditResult = await runCryptographicAudit(baseMint);

            // 2. FILTER & DB CACHE
            if (auditResult.passed) {
                // If the token is safe, log it to the Finder database for the Telegram UI to broadcast
                await supabase.from('discovered_tokens').insert({
                    mint_address: baseMint,
                    token_name: "Discovered Token", // Typically fetched via Metaplex metadata
                    token_symbol: "UNKNOWN",
                    initial_liquidity_usd: 0, // Calculated via subsequent Geckoterminal ping
                    insider_allocation_percentage: 0,
                    jito_bundled_mints: tx.description?.toLowerCase().includes('jito') || false,
                    developer_ancestry_score: 90 // Default safe score pending deeper analysis
                });
                
                console.log(`[🟢 SECURE TOKEN DETECTED & LOGGED] CA: ${baseMint}`);
            } else {
                console.log(`[🔴 TOXIC TOKEN REJECTED] CA: ${baseMint} | Reason: ${auditResult.hazardFlags[0]}`);
            }
        }

        return res.status(200).json({ success: true, message: 'Block parsed successfully' });

    } catch (error: any) {
        console.error("Interceptor Crash:", error);
        return res.status(500).json({ success: false, error: error.message });
    }
}