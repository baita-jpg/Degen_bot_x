// api/webhook-helius.ts
import { VercelRequest, VercelResponse } from '@vercel/node';
import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = process.env.SUPABASE_URL || '';
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });

// Optional: You can set a secret header in Helius to prevent spam
const HELIUS_AUTH_SECRET = process.env.HELIUS_AUTH_SECRET || '';

export default async function handler(req: VercelRequest, res: VercelResponse) {
    // Webhooks must be POST requests
    if (req.method !== 'POST') {
        return res.status(405).send('Method Not Allowed');
    }

    // Security check (if you configured an auth header in Helius)
    if (HELIUS_AUTH_SECRET && req.headers['authorization'] !== HELIUS_AUTH_SECRET) {
        return res.status(401).send('Unauthorized');
    }

    try {
        const payload = req.body;
        
        // Helius sends an array of enriched transactions
        if (!Array.isArray(payload) || payload.length === 0) {
            return res.status(200).send('Empty payload ignored');
        }

        for (const tx of payload) {
            // Extract the core data from the Helius Enriched Transaction format
            const signature = tx.signature;
            const type = tx.type || 'UNKNOWN'; 
            const timestamp = new Date(tx.timestamp * 1000).toISOString();
            
            // Assume the fee payer is the primary whale wallet executing the trade
            const walletAddress = tx.feePayer || 'SYSTEM';

            // Extract the human-readable description Helius provides (e.g., "Wallet swapped 500 SOL for USDC")
            // We will store this in the token_symbol column temporarily to display in the UI easily
            const descriptionSnippet = tx.description ? tx.description.substring(0, 150) : `${type} Executed`;

            // Commit to the Supabase database
            const { error } = await supabase.from('whale_transactions').insert({
                wallet_address: walletAddress,
                tx_signature: signature,
                token_address: 'MIXED_ROUTING', // Placeholder for complex multi-hop swaps
                token_symbol: descriptionSnippet, // Storing the description here for the UI
                tx_type: type,
                sol_amount: 0, 
                executed_at: timestamp
            });

            if (error) {
                console.error("Database Write Error:", error);
            }
        }

        // You MUST return a 200 OK quickly, otherwise Helius will think the webhook failed and retry endlessly
        return res.status(200).send('Webhook Processed');

    } catch (error: any) {
        console.error("Helius Webhook Crash:", error);
        return res.status(500).send('Internal Server Error');
    }
}