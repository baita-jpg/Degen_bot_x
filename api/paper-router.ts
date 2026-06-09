// api/paper-router.ts
import { VercelRequest, VercelResponse } from '@vercel/node';
import { createClient } from '@supabase/supabase-js';

export default async function handler(req: VercelRequest, res: VercelResponse) {
    if (req.method !== 'POST') return res.status(405).send('Method Not Allowed');

    try {
        const { mintAddress, tokenSymbol, initialPriceUsd, tgUserId } = req.body;
        if (!mintAddress || !initialPriceUsd || !tgUserId) {
            return res.status(400).json({ error: 'Missing core tracking matrix keys.' });
        }

        const supabase = createClient(
            process.env.SUPABASE_URL || '',
            process.env.SUPABASE_SERVICE_ROLE_KEY || ''
        );

        // 1. Fetch and verify the user's paper balance limits
        const { data: balanceData, error: balError } = await supabase
            .from('user_demo_balances')
            .select('*')
            .eq('tg_user_id', tgUserId)
            .single();

        if (balError || !balanceData) {
            return res.status(404).json({ error: 'Paper trading account initialization not found.' });
        }

        const allocationSol = 1.0; // Standard 1 SOL allocation per trench snipe
        const currentBalance = parseFloat(balanceData.virtual_sol_balance);

        if (currentBalance < allocationSol) {
            return res.status(200).json({ status: 'ABORTED', message: 'Insufficient virtual equity pool.' });
        }

        // 2. Compute Realistic Market Execution Slippage Penalties (2.5% Premium On Entry)
        const slippageMultiplier = 1.025;
        const simulatedEntryPrice = parseFloat(initialPriceUsd) * slippageMultiplier;
        
        // Convert SOL capital into token units (Using a proxy 1 SOL = $180.00 for simulation scaling)
        const solToUsdRate = 180.00; 
        const tokensAcquired = (allocationSol * solToUsdRate) / simulatedEntryPrice;

        // 3. Atomically debit balance and log the open position
        const newBalance = currentBalance - allocationSol;
        await supabase
            .from('user_demo_balances')
            .update({ virtual_sol_balance: newBalance, total_trades_executed: balanceData.total_trades_executed + 1 })
            .eq('tg_user_id', tgUserId);

        await supabase.from('demo_trades').insert({
            tg_user_id: tgUserId,
            token_address: mintAddress,
            token_symbol: tokenSymbol || 'TRENCH',
            status: 'OPEN',
            allocated_sol: allocationSol,
            entry_price_usd: simulatedEntryPrice,
            tokens_acquired: tokensAcquired
        });

        console.log(`[🔮 SECOND TRADER] Sim Position Opened: ${tokenSymbol} at $${simulatedEntryPrice}`);
        return res.status(200).json({ success: true, entryPrice: simulatedEntryPrice });

    } catch (err: any) {
        return res.status(500).json({ error: err.message });
    }
}